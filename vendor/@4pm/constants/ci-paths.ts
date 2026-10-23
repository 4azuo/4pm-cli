/**
 * The CI workflow files 4PM may propose (Save as PR / AI authoring): GitHub workflow files and the GitLab CI config,
 * with the size caps of one proposal. Shared by the web editor, the server (`machine-0101`) and the cli (`ci.propose`).
 * @adr 0606 @api machine-0101
 */

/** A path a proposal may touch: `.github/workflows/<file>.y(a)ml`, `.gitlab-ci.yml`, `.gitlab/ci/**.y(a)ml`. */
export const CI_PROPOSE_PATH = /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.gitlab\/ci\/(?:[^/]+\/)*[^/]+\.ya?ml)$/;
/** Largest file content (bytes). */
export const CI_PROPOSE_MAX_FILE_BYTES = 256 * 1024;
/** Most files in one proposal. */
export const CI_PROPOSE_MAX_FILES = 20;
