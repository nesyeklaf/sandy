import type { EnrollmentBootstrap } from "./enrollments.js";

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function manualEnrollmentCommand(
  bootstrap: EnrollmentBootstrap,
): string {
  const header = `X-SANDY-Enrollment: ${bootstrap.credential}`;
  const installerUrl = new URL("/install.sh", bootstrap.serverUrl).href;
  return `curl -sSL --fail-with-body -H ${quote(header)} ${quote(installerUrl)} | sh`;
}

function quotePowerShell(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

export function manualEnrollmentPowerShellCommand(
  bootstrap: EnrollmentBootstrap,
): string {
  const installerUrl = new URL("/install.ps1", bootstrap.serverUrl).href;
  return `irm -Headers @{ 'X-SANDY-Enrollment' = ${quotePowerShell(bootstrap.credential)} } ${quotePowerShell(installerUrl)} | iex`;
}

export function windowsInstallerFailureScript(message: string): string {
  return `throw ${quotePowerShell(message)}\n`;
}

export function enrolledWindowsInstallerScript(
  installer: string,
  bootstrap: EnrollmentBootstrap,
): string {
  if (/^'@/mu.test(installer)) {
    throw new Error(
      "The Windows machine installer cannot contain a line that starts with '@",
    );
  }
  return [
    "$ErrorActionPreference = 'Stop'",
    "$sandyNode = Get-Command node.exe -ErrorAction SilentlyContinue",
    "if ($null -eq $sandyNode) { throw 'sandy-app requires Node.js 22.19 or newer (22.19, 24, and 26 are tested), but node is not on PATH.' }",
    "$sandyInstaller = Join-Path ([IO.Path]::GetTempPath()) ('sandy-install-machine-' + [guid]::NewGuid().ToString('N') + '.mjs')",
    "[IO.File]::WriteAllText($sandyInstaller, @'",
    installer.replace(/\r?\n$/u, ""),
    "'@, (New-Object Text.UTF8Encoding $false))",
    `$env:SANDY_ENROLLMENT = ${quotePowerShell(JSON.stringify(bootstrap))}`,
    "try {",
    "  & $sandyNode.Source $sandyInstaller --bootstrap-env SANDY_ENROLLMENT",
    '  if ($LASTEXITCODE -ne 0) { throw "sandy machine setup failed with exit code $LASTEXITCODE." }',
    "} finally {",
    "  Remove-Item Env:SANDY_ENROLLMENT -ErrorAction SilentlyContinue",
    "  Remove-Item -LiteralPath $sandyInstaller -Force -ErrorAction SilentlyContinue",
    "}",
    "",
  ].join("\n");
}

export function enrolledInstallerScript(
  script: string,
  bootstrap: EnrollmentBootstrap,
): string {
  return `export SANDY_ENROLLMENT=${quote(JSON.stringify(bootstrap))}\nset -- --bootstrap-env SANDY_ENROLLMENT\n${script}`;
}
