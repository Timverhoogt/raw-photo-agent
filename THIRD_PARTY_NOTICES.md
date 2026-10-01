# Third-party notices

This file documents bundled third-party source and example media. This project's first-party code is licensed under the MIT License; see [LICENSE](LICENSE). The notices below apply to the third-party components and media named here.

## json.lua

- Component: [rxi/json.lua](https://github.com/rxi/json.lua), version 0.1.2.
- Upstream version: [v0.1.2](https://github.com/rxi/json.lua/tree/v0.1.2).
- Bundled file: [plugin/RawPhotoAgent.lrplugin/vendor/json.lua](plugin/RawPhotoAgent.lrplugin/vendor/json.lua).
- Copyright: Copyright (c) 2019 rxi.
- License: MIT; the complete notice is retained in the source and [JSON-LICENSE.txt](plugin/RawPhotoAgent.lrplugin/vendor/JSON-LICENSE.txt).
- Modifications: none. Both bundled files match the corresponding upstream v0.1.2 files byte for byte.

Preserve the copyright and permission notice when redistributing this component.

## README example photograph

The two [README comparison previews](docs/example.md) were rendered in Lightroom from a Photography Life Canon EOS R RAW sample. Credit for the source photograph belongs to [Photography Life](https://photographylife.com/). The example documents a guided editing trial; this repository does not claim ownership of the photograph or grant a license to it. The [example notes](docs/example.md#photo-source) identify the source and adjustments.

## External runtimes and packages

Adobe Lightroom Classic is a separately installed product and provides the Lightroom SDK runtime modules imported by the plugin. No Adobe application or SDK distribution is bundled here. This project is not affiliated with Adobe.

Lua 5.1, or Python 3 with the optional Lupa package, can run the plugin's mocked offline checks. They are not vendored in this repository. Dependencies installed through package managers retain their respective licenses and notices supplied with those packages.
