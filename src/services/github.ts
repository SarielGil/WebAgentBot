import { Octokit } from '@octokit/rest';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

export class GitHubService {
  public octokit: Octokit;

  constructor() {
    const envs = readEnvFile(['GITHUB_TOKEN']);
    const token = envs.GITHUB_TOKEN || process.env.GITHUB_TOKEN;

    if (!token) {
      throw new Error('GITHUB_TOKEN is missing from .env');
    }

    this.octokit = new Octokit({
      auth: token,
    });
  }

  async createRepo(name: string, description: string = ''): Promise<string> {
    try {
      const response = await this.octokit.repos.createForAuthenticatedUser({
        name,
        description,
        auto_init: true,
      });

      logger.info({ repo: name }, 'GitHub repository created');
      return response.data.html_url;
    } catch (err) {
      logger.error({ err, repo: name }, 'Failed to create GitHub repository');
      throw err;
    }
  }

  async createMilestone(
    owner: string,
    repo: string,
    title: string,
    description: string = '',
  ): Promise<void> {
    try {
      await this.octokit.issues.createMilestone({
        owner,
        repo,
        title,
        description,
      });
      logger.info({ repo, milestone: title }, 'Milestone created');
    } catch (err) {
      logger.error(
        { err, repo, milestone: title },
        'Failed to create milestone',
      );
    }
  }

  async pushFiles(
    owner: string,
    repo: string,
    files: Array<{
      path: string;
      content: string;
      encoding?: 'utf-8' | 'base64';
    }>,
    message: string = 'Initial website backbone',
  ): Promise<void> {
    try {
      // For simplicity, we assume we're pushing to the default branch (usually main)
      const { data: repoData } = await this.octokit.repos.get({ owner, repo });
      const defaultBranch = repoData.default_branch;

      // Get the latest commit SHA
      const { data: refData } = await this.octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${defaultBranch}`,
      });
      const latestCommitSha = refData.object.sha;

      // Get the tree SHA
      const { data: commitData } = await this.octokit.repos.getCommit({
        owner,
        repo,
        ref: latestCommitSha,
      });
      const treeSha = commitData.commit.tree.sha;

      // Fetch the current tree state to ensure we merge instead of replace
      const { data: currentTree } = await this.octokit.git.getTree({
        owner,
        repo,
        tree_sha: treeSha,
        recursive: 'true',
      });

      // Keep all existing files that aren't being updated
      const existingFiles = currentTree.tree
        .filter(
          (item) =>
            item.type === 'blob' && !files.find((f) => f.path === item.path),
        )
        .map((item) => ({
          path: item.path as string,
          mode: item.mode as '100644',
          type: 'blob' as const,
          sha: item.sha as string,
        }));

      // Create blobs and tree
      const newBlobs = await Promise.all(
        files.map(async (f) => {
          const { data: blob } = await this.octokit.git.createBlob({
            owner,
            repo,
            content: f.content,
            encoding: f.encoding || 'utf-8',
          });
          return {
            path: f.path,
            mode: '100644' as const,
            type: 'blob' as const,
            sha: blob.sha,
          };
        }),
      );

      const { data: newTree } = await this.octokit.git.createTree({
        owner,
        repo,
        base_tree: treeSha,
        tree: [...existingFiles, ...newBlobs],
      });

      const { data: newCommit } = await this.octokit.git.createCommit({
        owner,
        repo,
        message,
        tree: newTree.sha,
        parents: [latestCommitSha],
      });

      await this.octokit.git.updateRef({
        owner,
        repo,
        ref: `heads/${defaultBranch}`,
        sha: newCommit.sha,
      });

      logger.info({ repo }, 'Files pushed to GitHub');
    } catch (err) {
      logger.error({ err, repo }, 'Failed to push files to GitHub');
      throw err;
    }
  }

  async enablePages(
    owner: string,
    repo: string,
    branch: string = 'main',
    path: '/' | '/docs' = '/',
  ): Promise<void> {
    try {
      await this.octokit.repos.createPagesSite({
        owner,
        repo,
        source: {
          branch,
          path,
        },
      });
      logger.info({ repo }, 'GitHub Pages enabled');
    } catch (err: any) {
      // 409 means Pages is already enabled
      if (err.status === 409) {
        logger.info({ repo }, 'GitHub Pages already enabled');
        return;
      }
      logger.error({ err, repo }, 'Failed to enable GitHub Pages');
      throw err;
    }
  }
}
