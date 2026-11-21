import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

// The job owns Codex and its MCP/command descendants. Windows closes the job on
// launcher exit, including after a crash. The launcher also watches Electron.
const launcher = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $file = $env:AHA_PILOT_JOB_FILE
  $commandLine = $env:AHA_PILOT_JOB_ARGS
  $owner = [uint32] $env:AHA_PILOT_JOB_OWNER
  Remove-Item Env:AHA_PILOT_JOB_FILE, Env:AHA_PILOT_JOB_ARGS, Env:AHA_PILOT_JOB_OWNER
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AhaCodexJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long PerProcessTime, PerJobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JobLimits {
    public BasicLimits Basic;
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct StartupInfo {
    public int Size;
    public IntPtr Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
    public ushort ShowWindow, ReservedSize;
    public IntPtr Reserved2, Input, Output, Error;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct StartupInfoEx {
    public StartupInfo Start;
    public IntPtr Attributes;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }

  [DllImport("kernel32", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, IntPtr name);
  [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref JobLimits limits, uint size);
  [DllImport("kernel32", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr previousSize);
  [DllImport("kernel32")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CreateProcess(string file, StringBuilder args, IntPtr processAttributes, IntPtr threadAttributes,
    bool inheritHandles, uint flags, IntPtr env, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
  [DllImport("kernel32")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32", SetLastError=true)] static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr duplicate, uint access, bool inherit, uint flags);
  [DllImport("kernel32", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
  [DllImport("kernel32", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
  [DllImport("kernel32", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool success) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
  }

  static IntPtr Inherit(int handle) {
    IntPtr result;
    IntPtr self = GetCurrentProcess();
    Check(DuplicateHandle(self, GetStdHandle(handle), self, out result, 0, true, 2));
    return result;
  }

  public static int Run(string file, string commandLine, uint ownerId) {
    IntPtr job = IntPtr.Zero, owner = IntPtr.Zero, jobSlot = IntPtr.Zero, list = IntPtr.Zero;
    IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
    bool initialized = false;
    ProcessInfo process = new ProcessInfo();
    try {
      owner = OpenProcess(0x00100000, false, ownerId);
      Check(owner != IntPtr.Zero);
      job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
      Check(job != IntPtr.Zero);
      JobLimits limits = new JobLimits();
      limits.Basic.Flags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job, 9, ref limits, (uint) Marshal.SizeOf(typeof(JobLimits))));

      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      Check(size != IntPtr.Zero);
      list = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(list, 1, 0, ref size));
      initialized = true;
      jobSlot = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobSlot, job);
      // PROC_THREAD_ATTRIBUTE_JOB_LIST assigns the child before it executes.
      Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x0002000D), jobSlot,
        new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));

      input = Inherit(-10);
      output = Inherit(-11);
      error = Inherit(-12);
      StartupInfoEx startup = new StartupInfoEx();
      startup.Start.Size = Marshal.SizeOf(typeof(StartupInfoEx));
      startup.Start.Flags = 0x100;
      startup.Start.Input = input;
      startup.Start.Output = output;
      startup.Start.Error = error;
      startup.Attributes = list;
      Check(CreateProcess(file, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero,
        true, 0x08080000, IntPtr.Zero, null, ref startup, out process));

      uint completed = WaitForMultipleObjects(2, new IntPtr[] { process.Process, owner }, false, 0xffffffff);
      if (completed == 1) return 1;
      Check(completed == 0);
      uint code;
      Check(GetExitCodeProcess(process.Process, out code));
      return unchecked((int) code);
    } finally {
      if (job != IntPtr.Zero) CloseHandle(job);
      foreach (IntPtr handle in new IntPtr[] { process.Thread, process.Process, input, output, error, owner }) {
        if (handle != IntPtr.Zero) CloseHandle(handle);
      }
      if (initialized) DeleteProcThreadAttributeList(list);
      if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
      if (jobSlot != IntPtr.Zero) Marshal.FreeHGlobal(jobSlot);
    }
  }
}
'@
  exit ([AhaCodexJob]::Run($file, $commandLine, $owner))
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
`;

function quoteWindowsArgument(argument: string): string {
  const escaped = argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return '"' + escaped + '"';
}

export function spawnWindowsCodexJob(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const powershell = win32.join(process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return spawn(powershell, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launcher, 'utf16le').toString('base64'),
  ], {
    cwd, windowsHide: true, stdio: 'pipe',
    env: {
      ...env,
      AHA_PILOT_JOB_FILE: file,
      AHA_PILOT_JOB_ARGS: [file, ...args].map(quoteWindowsArgument).join(' '),
      AHA_PILOT_JOB_OWNER: String(process.pid),
    },
  });
}
