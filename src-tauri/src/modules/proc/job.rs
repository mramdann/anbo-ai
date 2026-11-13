//! Windows Job Object with KILL_ON_JOB_CLOSE for child process trees.
//! Dropping the handle kills the whole tree, the only reliable orphan guard
//! on Windows.

#![cfg(windows)]

use std::io;
use std::mem::{size_of, zeroed};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_MORE_DATA, FALSE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};

pub struct ProcessJob {
    handle: HANDLE,
}

unsafe impl Send for ProcessJob {}
unsafe impl Sync for ProcessJob {}

impl ProcessJob {
    /// Read-only membership check against this exact job, never a PID/name guess.
    pub fn contains(&self, pid: u32) -> bool {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
            if process.is_null() {
                return false;
            }
            let member = self.contains_process(process);
            CloseHandle(process);
            member
        }
    }

    /// The same, for a process the caller holds open: what it learns is
    /// about that very process, whoever has its pid by now.
    ///
    /// # Safety
    ///
    /// `process` must be a valid process handle with
    /// PROCESS_QUERY_LIMITED_INFORMATION.
    pub unsafe fn contains_process(&self, process: HANDLE) -> bool {
        let mut member = FALSE;
        IsProcessInJob(process, self.handle, &mut member) != 0 && member != FALSE
    }

    /// The pids of the processes in the job right now. A process that was
    /// ended and is not gone yet is still among them; one that was started
    /// before its parent joined the job never is.
    pub fn process_ids(&self) -> Vec<u32> {
        let mut capacity = 128_usize;
        loop {
            let bytes =
                size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() + (capacity - 1) * size_of::<usize>();
            // Whole usize units keep the list aligned.
            let mut buffer = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
            let read = unsafe {
                QueryInformationJobObject(
                    self.handle,
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast(),
                    bytes as u32,
                    std::ptr::null_mut(),
                )
            } != 0;
            let more = !read && unsafe { GetLastError() } == ERROR_MORE_DATA;
            if !read && !more {
                return Vec::new();
            }
            let list = buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
            let (assigned, listed) = unsafe {
                (
                    (*list).NumberOfAssignedProcesses as usize,
                    (*list).NumberOfProcessIdsInList as usize,
                )
            };
            if more && assigned > capacity && capacity < 1 << 16 {
                capacity = assigned + 32;
                continue;
            }
            let first = unsafe { std::ptr::addr_of!((*list).ProcessIdList).cast::<usize>() };
            return unsafe { std::slice::from_raw_parts(first, listed.min(capacity)) }
                .iter()
                .map(|pid| *pid as u32)
                .collect();
        }
    }

    pub fn create_for(pid: u32) -> io::Result<Self> {
        unsafe {
            let process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, FALSE, pid);
            if process.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self::create_for_process(process);
            CloseHandle(process);
            job
        }
    }

    /// The same, for a process the caller already holds open (with
    /// PROCESS_TERMINATE and PROCESS_SET_QUOTA), so whatever it checked on that
    /// handle is the process that lands in the job. The handle stays open.
    ///
    /// # Safety
    ///
    /// `process` must be a valid process handle with those access rights.
    pub unsafe fn create_for_process(process: HANDLE) -> io::Result<Self> {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() || job == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            let e = io::Error::last_os_error();
            CloseHandle(job);
            return Err(e);
        }

        if AssignProcessToJobObject(job, process) == 0 {
            let e = io::Error::last_os_error();
            CloseHandle(job);
            return Err(e);
        }

        Ok(Self { handle: job })
    }

    pub fn terminate(&self) -> io::Result<()> {
        let ok = unsafe { TerminateJobObject(self.handle, 1) };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        if !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.handle) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{Duration, Instant};

    #[test]
    fn create_for_invalid_pid_errors() {
        match ProcessJob::create_for(0xFFFFFFFE) {
            Err(_) => {}
            Ok(_) => panic!("invalid pid must error"),
        }
    }

    #[test]
    fn drop_kills_assigned_process_tree() {
        let mut child = Command::new("cmd.exe")
            .args(["/C", "ping -n 30 127.0.0.1 > nul"])
            .spawn()
            .expect("spawn cmd.exe");

        let job = ProcessJob::create_for(child.id()).expect("create job");
        assert!(job.contains(child.id()));
        assert!(!job.contains(std::process::id()));
        assert!(!job.contains(0xFFFFFFFE));
        let listed = job.process_ids();
        assert!(listed.contains(&child.id()), "{listed:?}");
        assert!(!listed.contains(&std::process::id()), "{listed:?}");
        drop(job);

        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait().expect("try_wait") {
                Some(_) => break,
                None if Instant::now() >= deadline => {
                    let _ = child.kill();
                    panic!("child survived 3s after ProcessJob drop");
                }
                None => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }
}
