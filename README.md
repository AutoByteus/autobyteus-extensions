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

The founder creates an Ed25519 key pair himself (`openssl genpkey -algorithm ed25519 -out key.pem`), stores the private
key only as the repository secret `EXTENSIONS_CATALOG_SIGNING_KEY`, and commits its public key
(`openssl pkey -in key.pem -pubout`) as `catalog-public-key.pem`; AutoByteus builds the same public key in
(`EXTENSIONS_CATALOG_PUBLIC_KEY_PEM`). The private key is never put in a file in the repository or a message.

### Developing against your own catalog

A node trusts another catalog when its environment sets `AUTOBYTEUS_EXTENSIONS_CATALOG_URL` (the catalog JSON; its
signature is the same URL with `.sig`) and `AUTOBYTEUS_EXTENSIONS_CATALOG_PUBLIC_KEY` (a PEM). Sign your catalog with
`scripts/sign-catalog.mjs` and your own key. Voice Input's server part also reads
`AUTOBYTEUS_VOICE_INPUT_MANIFEST_URL` to install another voice runtime build.
