//! Cosmetic lifecycle attribution, not authorization. Resolve only exact local
//! transport endpoints and existing PTY Job Objects. No process-name heuristics,
//! shell commands, CLI configuration, background poller, or foreground changes.

#[cfg(windows)]
use tauri::Manager;

pub async fn http_owner(
    app: tauri::AppHandle,
    peer: std::net::SocketAddr,
    local: std::net::SocketAddr,
) -> Option<u32> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let pid = windows::tcp_pid(peer, local)?;
            app.try_state::<crate::modules::pty::PtyState>()?
                .owner_of_process(pid)
        })
        .await
        .ok()
        .flatten()
    }
    #[cfg(not(windows))]
    {
        let _ = (app, peer, local);
        None
    }
}

#[cfg(windows)]
pub async fn pipe_owner(
    app: tauri::AppHandle,
    stream: &tokio::net::windows::named_pipe::NamedPipeServer,
) -> Option<u32> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
    let mut pid = 0;
    if unsafe { GetNamedPipeClientProcessId(stream.as_raw_handle(), &mut pid) } == 0 {
        return None;
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.try_state::<crate::modules::pty::PtyState>()?
            .owner_of_process(pid)
    })
    .await
    .ok()
    .flatten()
}

#[cfg(windows)]
mod windows {
    use std::mem::{offset_of, size_of};
    use std::net::SocketAddr;
    use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET;

    // IPv4 only: the MCP listener is explicitly bound to 127.0.0.1.
    pub(super) fn tcp_pid(peer: SocketAddr, local: SocketAddr) -> Option<u32> {
        if !peer.ip().is_loopback() || !local.ip().is_loopback() {
            return None;
        }
        let mut bytes = 0u32;
        let status = unsafe {
            GetExtendedTcpTable(
                std::ptr::null_mut(),
                &mut bytes,
                0,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        };
        if status != ERROR_INSUFFICIENT_BUFFER {
            return None;
        }
        for _ in 0..3 {
            if bytes as usize > 4 * 1024 * 1024 || bytes < 4 {
                return None;
            }
            // DWORD alignment; parse using the SDK's offsets and row size.
            let mut buffer = vec![0u32; (bytes as usize).div_ceil(4)];
            let capacity = buffer.len() * 4;
            let status = unsafe {
                GetExtendedTcpTable(
                    buffer.as_mut_ptr().cast(),
                    &mut bytes,
                    0,
                    AF_INET as u32,
                    TCP_TABLE_OWNER_PID_ALL,
                    0,
                )
            };
            if status == ERROR_INSUFFICIENT_BUFFER {
                continue;
            }
            if status != NO_ERROR || bytes as usize > capacity {
                return None;
            }
            let data =
                unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), bytes as usize) };
            return parse_table(data, peer, local);
        }
        None
    }

    fn parse_table(data: &[u8], peer: SocketAddr, local: SocketAddr) -> Option<u32> {
        let (SocketAddr::V4(peer), SocketAddr::V4(local)) = (peer, local) else {
            return None;
        };
        let count = u32::from_ne_bytes(data.get(..4)?.try_into().ok()?) as usize;
        let offset = offset_of!(MIB_TCPTABLE_OWNER_PID, table);
        let stride = size_of::<MIB_TCPROW_OWNER_PID>();
        let end = offset.checked_add(count.checked_mul(stride)?)?;
        let rows = data.get(offset..end)?;
        let mut found = None;
        for bytes in rows.chunks_exact(stride) {
            // Every row is a POD C struct and the bounds were validated above.
            let row = unsafe {
                bytes
                    .as_ptr()
                    .cast::<MIB_TCPROW_OWNER_PID>()
                    .read_unaligned()
            };
            if row.dwLocalAddr == u32::from_ne_bytes(peer.ip().octets())
                && u16::from_be(row.dwLocalPort as u16) == peer.port()
                && row.dwRemoteAddr == u32::from_ne_bytes(local.ip().octets())
                && u16::from_be(row.dwRemotePort as u16) == local.port()
                && row.dwOwningPid > 0
            {
                if found.is_some() {
                    return None;
                }
                found = Some(row.dwOwningPid);
            }
        }
        found
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn real_loopback_connection_maps_to_its_own_process() {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            let (server, peer) = listener.accept().unwrap();
            assert_eq!(
                tcp_pid(peer, server.local_addr().unwrap()),
                Some(std::process::id())
            );
            assert_eq!(
                tcp_pid("127.0.0.2:1".parse().unwrap(), server.local_addr().unwrap()),
                None
            );
            drop((client, server));
        }

        #[test]
        fn malformed_tables_never_read_past_the_buffer() {
            let addr = "127.0.0.1:1234".parse().unwrap();
            for data in [
                vec![],
                vec![1, 0, 0],
                u32::MAX.to_ne_bytes().to_vec(),
                vec![1, 0, 0, 0],
            ] {
                assert_eq!(parse_table(&data, addr, addr), None);
            }
        }
    }
}
