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
pub fn pipe_client(stream: &tokio::net::windows::named_pipe::NamedPipeServer) -> Option<u32> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
    let mut pid = 0;
    (unsafe { GetNamedPipeClientProcessId(stream.as_raw_handle(), &mut pid) } != 0).then_some(pid)
}

#[cfg(windows)]
pub async fn pipe_owner(
    app: tauri::AppHandle,
    stream: &tokio::net::windows::named_pipe::NamedPipeServer,
) -> Option<u32> {
    let pid = pipe_client(stream)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.try_state::<crate::modules::pty::PtyState>()?
            .owner_of_process(pid)
    })
    .await
    .ok()
    .flatten()
}

/// The process listening on a loopback address, for telling the user which app
/// holds a port Anbo needs. Shown, never used to authorize anything.
#[cfg(windows)]
pub fn listener_pid(addr: std::net::SocketAddrV4) -> Option<u32> {
    windows::listener_pid(addr)
}

#[cfg(windows)]
mod windows {
    use std::mem::{offset_of, size_of};
    use std::net::{SocketAddr, SocketAddrV4};
    use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_CLASS,
        TCP_TABLE_OWNER_PID_ALL, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET;

    // IPv4 only: the MCP listener is explicitly bound to 127.0.0.1.
    pub(super) fn tcp_pid(peer: SocketAddr, local: SocketAddr) -> Option<u32> {
        if !peer.ip().is_loopback() || !local.ip().is_loopback() {
            return None;
        }
        let (SocketAddr::V4(peer), SocketAddr::V4(local)) = (peer, local) else {
            return None;
        };
        connection_owner(&owner_table(TCP_TABLE_OWNER_PID_ALL)?, peer, local)
    }

    pub(super) fn listener_pid(addr: SocketAddrV4) -> Option<u32> {
        listener_owner(&owner_table(TCP_TABLE_OWNER_PID_LISTENER)?, addr)
    }

    fn owner_table(class: TCP_TABLE_CLASS) -> Option<Vec<u8>> {
        let mut bytes = 0u32;
        let status = unsafe {
            GetExtendedTcpTable(
                std::ptr::null_mut(),
                &mut bytes,
                0,
                AF_INET as u32,
                class,
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
                    class,
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
            return Some(data.to_vec());
        }
        None
    }

    fn rows(data: &[u8]) -> Option<Vec<MIB_TCPROW_OWNER_PID>> {
        let count = u32::from_ne_bytes(data.get(..4)?.try_into().ok()?) as usize;
        let offset = offset_of!(MIB_TCPTABLE_OWNER_PID, table);
        let stride = size_of::<MIB_TCPROW_OWNER_PID>();
        let end = offset.checked_add(count.checked_mul(stride)?)?;
        let rows = data.get(offset..end)?;
        Some(
            rows.chunks_exact(stride)
                // Every row is a POD C struct and the bounds were validated above.
                .map(|bytes| unsafe {
                    bytes
                        .as_ptr()
                        .cast::<MIB_TCPROW_OWNER_PID>()
                        .read_unaligned()
                })
                .collect(),
        )
    }

    fn connection_owner(data: &[u8], peer: SocketAddrV4, local: SocketAddrV4) -> Option<u32> {
        let mut found = None;
        for row in rows(data)? {
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

    /// A listener on the wildcard address takes the same connections, so it
    /// counts when nothing listens on the exact address.
    fn listener_owner(data: &[u8], addr: SocketAddrV4) -> Option<u32> {
        let rows = rows(data)?;
        let on = |ip: u32| {
            rows.iter()
                .find(|row| {
                    row.dwLocalAddr == ip
                        && u16::from_be(row.dwLocalPort as u16) == addr.port()
                        && row.dwOwningPid > 0
                })
                .map(|row| row.dwOwningPid)
        };
        on(u32::from_ne_bytes(addr.ip().octets())).or_else(|| on(0))
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
        fn a_held_port_names_the_process_listening_on_it() {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let SocketAddr::V4(addr) = listener.local_addr().unwrap() else {
                unreachable!("bound to an IPv4 address");
            };
            assert_eq!(listener_pid(addr), Some(std::process::id()));
            drop(listener);
            assert_eq!(listener_pid(addr), None);
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
                assert_eq!(connection_owner(&data, addr, addr), None);
                assert_eq!(listener_owner(&data, addr), None);
            }
        }
    }
}
