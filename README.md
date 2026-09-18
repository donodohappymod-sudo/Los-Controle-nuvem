# LOS COLLECTOR

Web platform for collecting, organizing, diagnosing, monitoring, merging and generating IPTV sources from public/authorized inputs.

## Modules
- Authentication and session protection
- Sources: website, M3U, M3U8, media and manual
- Collector with M3U parsing and public HTML media-link discovery
- Library: channels, movies, series and episodes
- Diagnosis with timeout/HTTP/latency status
- Server-side monitoring command
- Source merge and M3U generation
- Generated source history
- Studio project management and FFmpeg render pipeline when FFmpeg is installed
- Responsive cyber-tech UI for mobile and desktop

## Security
Never use the collector to bypass authentication, CAPTCHA, DRM, paywalls or anti-bot controls. Only collect content from sources you are authorized to access.

## Deploy
Set `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `SESSION_SECRET` and persistent `STORAGE_ROOT`. The initial password is read from environment variables and is never stored in source code. Change it after first access.
