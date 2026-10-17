# anbo-shell-integration (PowerShell)
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D so the host tracks cwd and prompt
# boundaries. C comes from a PSConsoleHostReadLine wrapper (PowerShell has no
# preexec hook).

if ($global:__ANBO_HOOKS_LOADED) { return }
$global:__ANBO_HOOKS_LOADED = $true

# What the command line just accepted found when it started: read, never
# changed (see __anbo_exit_code).
$global:__anbo_armed = $false
$global:__anbo_exit_before = $null
$global:__anbo_error_before = $null

try {
    [Console]::InputEncoding  = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $global:OutputEncoding    = [System.Text.UTF8Encoding]::new($false)
} catch {}

if (Test-Path Function:prompt) {
    Copy-Item Function:prompt Function:__anbo_user_prompt -Force -ErrorAction SilentlyContinue
}

function global:__anbo_urlencode {
    param([string]$s)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($s)
    $sb = [System.Text.StringBuilder]::new($bytes.Length)
    foreach ($b in $bytes) {
        if (($b -ge 0x30 -and $b -le 0x39) -or
            ($b -ge 0x41 -and $b -le 0x5A) -or
            ($b -ge 0x61 -and $b -le 0x7A) -or
            $b -eq 0x2F -or $b -eq 0x2E -or $b -eq 0x5F -or
            $b -eq 0x7E -or $b -eq 0x2D) {
            [void]$sb.Append([char]$b)
        } else {
            [void]$sb.AppendFormat('%{0:X2}', $b)
        }
    }
    $sb.ToString()
}

# Wrap PSConsoleHostReadLine (defined by PSReadLine) to emit OSC 133 C with
# the accepted command line just before execution. Installed lazily from
# prompt: PSReadLine may finish loading only after this profile has run.
function global:__anbo_install_readline {
    if ($global:__anbo_readline_done) { return }
    if (-not (Test-Path Function:PSConsoleHostReadLine)) { return }
    $global:__anbo_readline_done = $true
    # global: is required -- a plain Function: copy made inside a function
    # lands in its local scope and vanishes when it returns, leaving the
    # wrapper calling a missing command on every read (empty-input loop).
    Copy-Item Function:PSConsoleHostReadLine Function:global:__anbo_user_readline -Force
    function global:PSConsoleHostReadLine {
        try {
            $line = __anbo_user_readline
        } catch {
            # Self-heal: restore the original reader so a broken wrapper can
            # never lock the shell out of input.
            Copy-Item Function:__anbo_user_readline Function:global:PSConsoleHostReadLine -Force
            return ''
        }
        try {
            if ($line -is [string] -and $line.Trim().Length -gt 0) {
                $global:__anbo_block_seen = $true
                $global:__anbo_exit_before = $global:LASTEXITCODE
                $global:__anbo_error_before = if ($global:Error.Count -gt 0) { $global:Error[0] } else { $null }
                $global:__anbo_armed = $true
                $esc = [char]27
                $cmd = $line -replace '[\x00-\x1F\x7F]', ' '
                if ($cmd.Length -gt 256) { $cmd = $cmd.Substring(0, 256) }
                [Console]::Write("$esc]133;C;$cmd$esc\")
            }
        } catch {}
        $line
    }
}

# The exit code a failed command line reports. LASTEXITCODE keeps the last
# native program's code until another program runs, so a cmdlet failing after
# `cmd /c exit 5` reported 5: the native code counts when it changed during
# the command line, or when no PowerShell error or Ctrl+C explains the failure.
function global:__anbo_exit_code {
    param($Native, $NativeBefore, [bool]$Armed, [bool]$NewError, [bool]$Stopped)
    $code = if ($null -eq $Native) { 0 } else { [int]$Native }
    if (-not $Armed) {
        # No command line was seen starting: nothing to compare with.
        if ($code -ne 0) { return $code }
        return 1
    }
    if ($code -ne 0 -and $Native -ne $NativeBefore) { return $code }
    if ($NewError -or $Stopped) { return 1 }
    # A native program failed again with the same code.
    if ($code -ne 0) { return $code }
    1
}

function global:prompt {
    # Capture $? before running any statement in this function. LASTEXITCODE
    # persists across PowerShell cmdlets, so consulting it first can report a
    # stale native success after a cmdlet or script exception.
    $commandSucceeded = $?
    $nativeExitCode = $LASTEXITCODE
    $newestError = if ($global:Error.Count -gt 0) { $global:Error[0] } else { $null }
    __anbo_install_readline
    $lec = 0
    if (-not $commandSucceeded) {
        try {
            # A failed cmdlet adds an error record; a failed native program,
            # or a command a Ctrl+C stopped, adds none.
            $newError = $null -ne $newestError -and
                -not [object]::ReferenceEquals($newestError, $global:__anbo_error_before)
            $stopped = $global:__anbo_armed -and -not $newError -and
                (Get-History -Count 1).ExecutionStatus -eq 'Stopped'
            $lec = __anbo_exit_code $nativeExitCode $global:__anbo_exit_before $global:__anbo_armed $newError $stopped
        } catch {
            $lec = if ($null -ne $nativeExitCode -and [int]$nativeExitCode -ne 0) { [int]$nativeExitCode } else { 1 }
        }
    }
    $global:__anbo_armed = $false
    $esc = [char]27

    $oscD = "$esc]133;D;$lec$esc\"
    $oscA = "$esc]133;A$esc\"
    $oscB = "$esc]133;B$esc\"

    $loc = Get-Location
    $osc7 = ''
    if ($loc.Provider.Name -eq 'FileSystem') {
        $cwd = $loc.ProviderPath -replace '\\','/'
        if ($cwd -match '^[A-Za-z]:') { $cwd = "/$cwd" }
        $cwdEnc = __anbo_urlencode $cwd
        $hostName = [System.Environment]::MachineName
        $osc7 = "$esc]7;file://$hostName$cwdEnc$esc\"
    }

    # Block mode: the host renders its own input bar, so suppress the shell
    # prompt (markers only) and reserve the header/gap rows in the prompt
    # itself -- same layout contract as the zsh integration.
    if ($env:ANBO_BLOCKS) {
        $global:LASTEXITCODE = $nativeExitCode
        $gap = if ($global:__anbo_block_seen) { "`n`n" } else { "`n" }
        return "$oscD$oscA$osc7$gap$oscB"
    }

    $original = if (Test-Path Function:__anbo_user_prompt) {
        try { & __anbo_user_prompt } catch { "PS $((Get-Location).Path)> " }
    } else {
        "PS $((Get-Location).Path)> "
    }

    # Shell integration must observe status without mutating the user's
    # native-command state.
    $global:LASTEXITCODE = $nativeExitCode
    "$oscD$oscA$osc7${original}${oscB}"
}
