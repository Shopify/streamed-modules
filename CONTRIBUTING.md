# How to contribute

This is a research prototype. It measures what streamed ES module execution buys, and feeds the standards work on
[TC39 module declarations](https://github.com/tc39/proposal-module-declarations) and their HTML integration.
Contributions that help with that are welcome.

## Things we will merge

* Bug fixes
* Improvements to the measurement tools and the throttling server
* Support for emitting the bundle format from other bundlers
* New test cases for the loader's semantics
* Documentation fixes that are short and correct

## Things we won't merge

* Changes that make results incomparable with the published numbers, without a good reason
* Features unrelated to streamed module execution
* Code that breaks existing tests

## Setting up

The `streamed` and `declarations` builds, and the tests, need a Chromium built with
[CL 5649434](https://chromium-review.googlesource.com/c/chromium/src/+/5649434), run with
`--enable-blink-features=ModuleDeclarations`. Measure on a release build only: a debug build's DCHECKs inflate parsing
costs many times over.

```bash
npm install
npm run gen
npm run build
npm test -- --chrome /path/to/patched/Chromium
```

## Workflow

* [Sign the CLA](https://cla.shopify.com/) if you haven't already
* Fork the repository and create a branch
* If you change the loader's semantics, add a case to `tests/cases.mjs`
* Make sure `npm run build` and `npm test` pass
* Open a pull request. If it changes measured results, include the numbers and how you got them: the Chromium build,
  the device, and the network conditions

## Reporting issues

Open a GitHub issue. Report security issues through Shopify's [bug bounty program](https://hackerone.com/shopify)
instead, not in a public issue.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
