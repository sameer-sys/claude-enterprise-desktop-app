import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const repo = 'sameer-sys/claude-enterprise-desktop-app';
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Claude-Enterprise-Desktop-App',
      },
      next: { revalidate: 60 },
    });

    if (!response.ok) {
      return NextResponse.json({
        hasUpdate: false,
        latestVersion: '1.0.0',
        currentVersion: '1.0.0',
        downloadUrl: `https://github.com/${repo}/releases`,
        releaseNotes: 'No published releases found yet.',
      });
    }

    const release = await response.json();
    const exeAsset = Array.isArray(release.assets)
      ? release.assets.find((a: any) => String(a.name).endsWith('.exe'))
      : null;

    const latestVersion = release.tag_name || release.name || '1.0.1';
    const downloadUrl = exeAsset?.browser_download_url || release.html_url || `https://github.com/${repo}/releases`;

    return NextResponse.json({
      hasUpdate: true,
      latestVersion,
      currentVersion: '1.0.0',
      downloadUrl,
      releaseNotes: release.body || 'New features, bug fixes, and performance improvements.',
      publishedAt: release.published_at,
    });
  } catch (error: any) {
    return NextResponse.json({
      hasUpdate: false,
      error: error?.message || 'Failed to check for updates',
    }, { status: 500 });
  }
}
