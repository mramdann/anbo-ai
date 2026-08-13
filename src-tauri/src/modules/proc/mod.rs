#[cfg(windows)]
pub mod job;

use std::collections::HashMap;
use std::io;
use std::process::{ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use shared_child::SharedChild;

const MAX_MANAGED_CHILDREN: usize = 256;
static MANAGED_CHILDREN: OnceLock<Mutex<HashMap<u32, Weak<ManagedChild>>>> = OnceLock::new();

fn managed_children() -> &'static Mutex<HashMap<u32, Weak<ManagedChild>>> {
    MANAGED_CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct ManagedChild {
    child: Arc<SharedChild>,
    #[cfg(windows)]
    job: Option<job::ProcessJob>,
}

impl ManagedChild {
    pub fn spawn(cmd: &mut Command) -> io::Result<Arc<Self>> {
        configure_process_tree(cmd);
        let child = Arc::new(SharedChild::spawn(cmd)?);
        #[cfg(windows)]
        let job = match job::ProcessJob::create_for(child.id()) {
            Ok(job) => Some(job),
            Err(error) => {
                if child.try_wait()?.is_some() {
                    None
                } else {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
            }
        };
        let managed = Arc::new(Self {
            child,
            #[cfg(windows)]
            job,
        });
        let mut children = managed_children()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        children.retain(|_, child| child.strong_count() > 0);
        if children.len() >= MAX_MANAGED_CHILDREN {
            drop(children);
            managed.kill_tree();
            let _ = managed.wait();
            return Err(io::Error::other("managed process limit reached"));
        }
        children.insert(managed.id(), Arc::downgrade(&managed));
        Ok(managed)
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn take_stdin(&self) -> Option<ChildStdin> {
        self.child.take_stdin()
    }

    pub fn take_stdout(&self) -> Option<ChildStdout> {
        self.child.take_stdout()
    }

    pub fn take_stderr(&self) -> Option<ChildStderr> {
        self.child.take_stderr()
    }

    pub fn wait(&self) -> io::Result<ExitStatus> {
        let status = self.child.wait();
        if status.is_ok() {
            managed_children()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&self.id());
        }
        status
    }

    pub fn try_wait(&self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait();
        if matches!(status, Ok(Some(_))) {
            managed_children()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&self.id());
        }
        status
    }

    pub fn kill_tree(&self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.id() as libc::pid_t), libc::SIGKILL);
        }
        #[cfg(windows)]
        if let Some(job) = &self.job {
            let _ = job.terminate();
        }
        let _ = self.child.kill();
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        self.kill_tree();
        managed_children()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.id());
    }
}

pub fn kill_all() {
    let children: Vec<_> = {
        let mut children = managed_children()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        children.retain(|_, child| child.strong_count() > 0);
        children.values().filter_map(Weak::upgrade).collect()
    };
    for child in children {
        child.kill_tree();
    }
}

#[cfg(unix)]
fn configure_process_tree(cmd: &mut Command) {
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
fn configure_process_tree(_cmd: &mut Command) {}

#[cfg(windows)]
pub fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
#[inline]
pub fn hide_console(_cmd: &mut Command) {}

#[cfg(all(test, unix))]
mod tests {
    use super::ManagedChild;
    use std::fs;
    use std::process::Command;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn kill_tree_terminates_a_spawned_descendant() {
        let directory = tempfile::tempdir().expect("tempdir");
        let pid_file = directory.path().join("descendant.pid");
        let script = format!(
            "sleep 30 & child=$!; echo $child > '{}'; wait",
            pid_file.display()
        );
        let mut command = Command::new("sh");
        command.args(["-c", &script]);
        let managed = ManagedChild::spawn(&mut command).expect("spawn managed shell");
        let deadline = Instant::now() + Duration::from_secs(3);
        let descendant_pid = loop {
            if let Ok(value) = fs::read_to_string(&pid_file) {
                if let Ok(pid) = value.trim().parse::<libc::pid_t>() {
                    break pid;
                }
            }
            assert!(Instant::now() < deadline, "descendant pid was not written");
            thread::sleep(Duration::from_millis(20));
        };
        managed.kill_tree();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let alive = unsafe { libc::kill(descendant_pid, 0) } == 0;
            if !alive {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "descendant survived managed process termination"
            );
            thread::sleep(Duration::from_millis(20));
        }
        let _ = managed.wait();
    }
}
