# AutoByteus Extensions

AutoByteus's extensions: optional capabilities a node installs from Settings → Extensions. This repository holds every
extension's package (one folder per extension) and the catalog AutoByteus trusts. AutoByteus installs only the
extensions this catalog lists, signed with AutoByteus's catalog key (the extension contract, version 1: AutoByteus's
`autobyteus-server-ts/docs/modules/extensions.md`).

Rule for every extension: anything valuable lives in the program it downloads or a service AutoByteus runs, never in
the package here, which is readable on every computer that installs it.

## Layout

```
<id>/extension.json     its description (contract §1)
<id>/server/index.mjs   its server part, one self-contained ES module, Node built-ins only (§4)
<id>/ui/index.html      its page; may load classic scripts, stylesheets and images next to it in ui/ (§2, §5)
catalog.json            the catalog: each entry is an extension.json plus packageUrl and sha256 (§3)
catalog-public-key.pem  the public half of the catalog signing key (the one AutoByteus builds in)
scripts/                pack, check-catalog, sign-catalog
```

| Extension | Offered on | What it downloads |
| --- | --- | --- |
| `voice-input` | the desktop app's own node | the voice runtime (pinned 0.3.2, `AutoByteus/autobyteus-voice-runtime`) and its speech model |

## Tests

`npm test` (Node 22, no dependencies): the Voice Input server part against a scripted runtime, packing, the catalog
check and signing.

## Releasing

Nothing is released without the founder's word.

1. **A package.** Raise the version in `<id>/extension.json`, merge, then push the tag `<id>-v<version>` (for example
   `voice-input-v1.0.0`). The workflow *Release an extension* tests, packs and publishes `<id>-<version>.tar.gz` and
   its `.sha256` on that tag's release (never Latest). Nodes do not see it yet.
2. **The catalog.** Put the entry in `catalog.json`: the package's `extension.json` fields plus
   `packageUrl` (`https://github.com/AutoByteus/autobyteus-extensions/releases/download/<id>-v<version>/<id>-<version>.tar.gz`)
   and `sha256` (from the release's `.sha256`). Merge, then run *Release the catalog*: it checks each listed package
   (download, SHA-256, `extension.json` equal to the entry), signs `catalog.json` with the secret
   `EXTENSIONS_CATALOG_SIGNING_KEY` (checked against `catalog-public-key.pem`) and replaces the assets of the fixed
   release `catalog`. Every node sees the new list the next time its Extensions page opens.

`node scripts/check-catalog.mjs` runs the catalog check locally.

### The catalog signing key (once)

Created on 2026-11-26 (autobyteus-657) on the founder's Mac by the setup script he approved, run on his word: the
script wrote the Ed25519 private key straight into a protected local file and into the repository secret
`EXTENSIONS_CATALOG_SIGNING_KEY`, and never printed it; no agent opens, reads, copies or commits it. The private key
exists only as that secret and in the founder's own backup. Its public half is `catalog-public-key.pem`
(fingerprint `SHA256:75d4d2f80ed35374e7956d736aed66111e3eac76b911eb2367428a27dc64ad4c`); AutoByteus builds the same
key in (`EXTENSIONS_CATALOG_PUBLIC_KEY_PEM`). The workflow *Check the signing key* proves the secret still matches
`catalog-public-key.pem` (it signs and verifies, publishing nothing). Changing the key is a coordinated change with a
new app release, never a fix for a failed run.

### Developing against your own catalog

A node trusts another catalog when its environment sets `AUTOBYTEUS_EXTENSIONS_CATALOG_URL` (the catalog JSON; its
signature is the same URL with `.sig`) and `AUTOBYTEUS_EXTENSIONS_CATALOG_PUBLIC_KEY` (a PEM). Sign your catalog with
`scripts/sign-catalog.mjs` and your own key. Voice Input's server part also reads
`AUTOBYTEUS_VOICE_INPUT_MANIFEST_URL` to install another voice runtime build.
