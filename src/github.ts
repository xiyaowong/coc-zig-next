import * as coc from 'coc.nvim'
import { USER_AGENT } from './util'

const API_ROOT = 'https://api.github.com'
const REQUEST_TIMEOUT = 30_000

export interface ReleaseAsset {
  name: string
  browser_download_url: string
}

export interface Release {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: ReleaseAsset[]
}

/** Returns the published, non-prerelease releases of a repository, newest first. */
export const fetchReleases = async (repository: string): Promise<Release[]> => {
  const releases = (await coc.fetch(`${API_ROOT}/repos/${repository}/releases?per_page=100`, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/vnd.github+json' },
    timeout: REQUEST_TIMEOUT,
  })) as Release[]

  if (!Array.isArray(releases)) return []

  return releases.filter(release => !release.draft && !release.prerelease)
}
