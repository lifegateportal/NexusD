export const MAX_CODING_STATIC_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MAX_CODING_STATIC_OUTPUT_BYTES = 50 * 1024 * 1024;
export const MAX_CODING_STATIC_ENTRY_COUNT = 2_000;
export const MAX_CODING_STATIC_PATH_BYTES = 1_024;
export const MAX_CODING_STATIC_SEGMENT_BYTES = 255;

const STATIC_CREDENTIAL_FILES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".yarnrc",
  ".yarnrc.yml",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);

export function isCodingEnvironmentFile(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => (
    /^\.env(?:$|\.)/i.test(segment) && !/\.example$/i.test(segment)
  ));
}

export function isCodingStaticSensitivePath(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => {
    const normalized = segment.toLowerCase();
    return (
      isCodingEnvironmentFile(segment)
      || STATIC_CREDENTIAL_FILES.has(normalized)
      || /\.(?:jks|p12|pfx|pem|key)$/.test(normalized)
    );
  });
}
