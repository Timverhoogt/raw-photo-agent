# Contributing

Start with the [architecture](DESIGN.md) and [current validation results](LIVE_VALIDATION.md). Keep changes focused on a reproducible editing problem.

## Development

```sh
npm ci
npm run check
npm test
```

The Lightroom plug-in has a separate [Lua test harness](plugin/RawPhotoAgent.lrplugin/tests/README.md). CI runs the TypeScript checks and the mocked Lua contracts; it does not run Lightroom.

For a native integration change, test on an explicitly selected RAW and a working virtual copy. Record the Lightroom version, before and after settings, rendered evidence, and restoration result. Distinguish exact settings restoration from exact pixel restoration. Keep those claims separate in the pull request.

## Reporting a problem

Include the command, expected result, actual result, Node.js version, Lightroom Classic version, and operating system. For timeouts, include whether the original request eventually received a response. Do not repeat an uncertain edit to reproduce the error.

Remove personal paths and identifiers from shared logs. RAW files, catalogs, run databases, generated configuration, and photo exports belong outside version control. Share a photo only when you have the rights and intend to make it available.

## Changes to the bridge

- Preserve exact photo targeting, virtual-copy protection, and state checks.
- Keep requests serialized and uncertain outcomes explicit.
- Add a focused test for a changed failure mode or protocol contract.
- Document new controls in the CLI guide and report their live validation separately from mock tests.
- Keep the original photo and earlier candidates available throughout a trial.

Third-party source must retain its license and attribution. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
