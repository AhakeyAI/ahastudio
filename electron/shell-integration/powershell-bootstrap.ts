// Ported/adapted from Orca (https://github.com/stablyai/orca).
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

import { encodePowerShellCommand } from '../shared/powershell-command-encoding.js';

const POWERSHELL_OSC133_BOOTSTRAP = `
if ($ExecutionContext.SessionState.LanguageMode -eq "FullLanguage" -and
    ((-not (Test-Path variable:global:__AhaOsc133State)) -or
     $null -eq $Global:__AhaOsc133State.OriginalPrompt)) {
    try {
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
        [Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
        $OutputEncoding = [System.Text.UTF8Encoding]::new()
    } catch { Write-Error $_ -ErrorAction Continue }

    $Global:__AhaOsc133State = @{
        OriginalPrompt = $function:prompt
        OriginalReadLine = $function:PSConsoleHostReadLine
        HasSeenPrompt = $false
        LastError = $global:Error[0]
        HasPSReadLine = $null -ne (Get-Module -Name PSReadLine)
        Esc = [char]27
        Bel = [char]7
    }

    function Global:prompt {
        $commandSucceeded = $global:?
        Set-StrictMode -Off
        $exitCode = [int](!$commandSucceeded)
        $lastError = $global:Error[0]
        if (!$commandSucceeded -and [object]::ReferenceEquals($lastError, $Global:__AhaOsc133State.LastError) -and $global:LASTEXITCODE) {
            $exitCode = $global:LASTEXITCODE
        }
        $Global:__AhaOsc133State.LastError = $lastError
        $result = ""
        if ($Global:__AhaOsc133State.HasSeenPrompt) {
            $result += "$($Global:__AhaOsc133State.Esc)]133;D;$exitCode$($Global:__AhaOsc133State.Bel)"
        }
        $Global:__AhaOsc133State.HasSeenPrompt = $true
        try {
            $fsPath = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath
            if ($fsPath) {
                $uri = ([System.Uri]$fsPath).AbsoluteUri
                $result += "$($Global:__AhaOsc133State.Esc)]7;$uri$($Global:__AhaOsc133State.Bel)"
            }
        } catch {}
        $result += "$($Global:__AhaOsc133State.Esc)]133;A$($Global:__AhaOsc133State.Bel)"
        if ($exitCode -ne 0) { Write-Error "failure" -ea ignore }
        $result += $Global:__AhaOsc133State.OriginalPrompt.Invoke()
        $result += "$($Global:__AhaOsc133State.Esc)]133;B$($Global:__AhaOsc133State.Bel)"
        $result
    }

    if ($Global:__AhaOsc133State.HasPSReadLine) {
        & {
            $bound = Get-PSReadLineKeyHandler -Bound -ErrorAction SilentlyContinue
            foreach ($pair in ('LeftArrow', 'b'), ('RightArrow', 'f')) {
                $source = $bound | Where-Object Key -ceq "Alt+$($pair[1])" | Select-Object -First 1
                if ($source -and -not ($bound | Where-Object Key -eq "Alt+$($pair[0])")) {
                    try { Set-PSReadLineKeyHandler -Chord "Alt+$($pair[0])" -Function $source.Function } catch {}
                }
            }
        }
    }

    if ($Global:__AhaOsc133State.HasPSReadLine -and
        $null -ne $Global:__AhaOsc133State.OriginalReadLine) {
        function Global:PSConsoleHostReadLine {
            $commandLine = $Global:__AhaOsc133State.OriginalReadLine.Invoke()
            [Console]::Write("$($Global:__AhaOsc133State.Esc)]133;C$($Global:__AhaOsc133State.Bel)")
            return $commandLine
        }
    }
}
`;

const POWERSHELL_OSC133_BOOTSTRAP_PAYLOAD = POWERSHELL_OSC133_BOOTSTRAP
  .replace(/^[ \t]*#.*\n/gm, '')
  .replace(/^[ \t]+/gm, '')
  .trim();

export function getPowerShellOsc133Bootstrap(): string {
  return POWERSHELL_OSC133_BOOTSTRAP_PAYLOAD;
}

export function getPowerShellOsc133EncodedCommand(): string {
  return encodePowerShellCommand(POWERSHELL_OSC133_BOOTSTRAP_PAYLOAD);
}

export function isPowerShellExecutableName(shellName: string): boolean {
  const normalized = shellName.toLowerCase();
  return (
    normalized === 'pwsh' ||
    normalized === 'pwsh.exe' ||
    normalized === 'powershell' ||
    normalized === 'powershell.exe'
  );
}
