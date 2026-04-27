#!/usr/bin/env bash
set -euo pipefail

repo="${RUNME_RELEASE_REPO:-runmedev/runme}"
requested_version="${1:-${RUNME_VERSION:-latest}}"
dest_dir="${2:-${RUNME_INSTALL_DIR:-$HOME/.local/bin}}"

case "$(uname -s)" in
  Linux)
    platform="linux"
    archive_ext="tar.gz"
    ;;
  Darwin)
    platform="darwin"
    archive_ext="tar.gz"
    ;;
  *)
    echo "Unsupported operating system: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64)
    arch="x86_64"
    ;;
  arm64 | aarch64)
    arch="arm64"
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

api_headers=(
  -H "Accept: application/vnd.github+json"
)

if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  api_headers+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

if [[ "${requested_version}" == "latest" ]]; then
  release_api="https://api.github.com/repos/${repo}/releases/latest"
else
  normalized_version="${requested_version#v}"
  release_api="https://api.github.com/repos/${repo}/releases/tags/v${normalized_version}"
fi

release_json="$(curl -fsSL "${api_headers[@]}" "${release_api}")"
release_tag="$(printf '%s' "${release_json}" | jq -r '.tag_name')"

if [[ -z "${release_tag}" || "${release_tag}" == "null" ]]; then
  echo "Failed to resolve Runme release tag from ${release_api}" >&2
  exit 1
fi

asset_name="runme_${platform}_${arch}.${archive_ext}"
download_url="https://github.com/${repo}/releases/download/${release_tag}/${asset_name}"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

archive_path="${tmp_dir}/${asset_name}"
curl -fsSL "${download_url}" -o "${archive_path}"
tar -xzf "${archive_path}" -C "${tmp_dir}"

runme_path="$(find "${tmp_dir}" -type f -name runme -print -quit)"
if [[ -z "${runme_path}" ]]; then
  echo "Runme binary not found in ${asset_name}" >&2
  exit 1
fi

mkdir -p "${dest_dir}"
install -m 0755 "${runme_path}" "${dest_dir}/runme"

echo "Installed ${release_tag} to ${dest_dir}/runme"
