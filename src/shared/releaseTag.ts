/** GitHub tag name (`GITHUB_REF_NAME`) must be exactly `v` + package.json version. */
export function releaseTagMatchesVersion(tagName: string, version: string): boolean {
  return tagName === `v${version}`
}
