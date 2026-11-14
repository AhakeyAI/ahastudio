// Phase 1 pure-TS shim for Orca's native @orca/windows-security ACL grant.
// Falls back to no-op until native Windows security bindings are explicitly added.

export function grantDirAcl(_dirPath: string): void {}

export async function grantDirAclAsync(_dirPath: string): Promise<void> {}
