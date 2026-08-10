# Changelog

## [0.0.11](https://github.com/wavekat/wavekat-flow/compare/flow-schema-v0.0.10...flow-schema-v0.0.11) (2026-08-10)


### ⚠ BREAKING CHANGES

* **book:** `BOOK_GRANULARITY_MINS` moves from 15 to 30, so `bookVocabularyRefs` / `vocabulary_refs` return a smaller set for the same node — 63 clips per voice rather than 111, and 29 rather than 44 for a Mon-Fri 09:00-17:00 step with 30-minute appointments.

### Features

* **book:** half-hour vocabulary grid ([#43](https://github.com/wavekat/wavekat-flow/issues/43)) ([988d7a4](https://github.com/wavekat/wavekat-flow/commit/988d7a4e4fd2f7002de4794d44b8e5e81e0fc1f2))


### Documentation

* **flow-schema:** how to take a grid change safely ([b21c6d5](https://github.com/wavekat/wavekat-flow/commit/b21c6d5eca2b2292b1b43e42545f391cfb3908ac))

## [0.0.10](https://github.com/wavekat/wavekat-flow/compare/flow-schema-v0.0.9...flow-schema-v0.0.10) (2026-08-09)


### Features

* derive and set a document's schema_version ([#41](https://github.com/wavekat/wavekat-flow/issues/41)) ([756c209](https://github.com/wavekat/wavekat-flow/commit/756c209e97553ce929787437d802330a175f65f3))

## [0.0.9](https://github.com/wavekat/wavekat-flow/compare/flow-schema-v0.0.8...flow-schema-v0.0.9) (2026-08-08)


### Features

* add the book component (schema_version 2) ([#39](https://github.com/wavekat/wavekat-flow/issues/39)) ([202f311](https://github.com/wavekat/wavekat-flow/commit/202f311f0a618b1eb99b5ee058044d09baaa9e5c))

## [0.0.8](https://github.com/wavekat/wavekat-flow/compare/flow-schema-v0.0.7...flow-schema-v0.0.8) (2026-07-20)


### Features

* **flow-schema:** add flow version diff ([#34](https://github.com/wavekat/wavekat-flow/issues/34)) ([218802e](https://github.com/wavekat/wavekat-flow/commit/218802ea54de4036672ad7cd344373e3fc7a0ed6))

## [0.0.7](https://github.com/wavekat/wavekat-flow/compare/flow-schema-v0.0.6...flow-schema-v0.0.7) (2026-07-20)


### Bug Fixes

* **flow-schema:** decode audio prompt transcript in TS parser ([#32](https://github.com/wavekat/wavekat-flow/issues/32)) ([dd8761a](https://github.com/wavekat/wavekat-flow/commit/dd8761a474bb2783211e0b62e1c0e66469778923))

## [0.0.6](https://github.com/wavekat/wavekat-flow/compare/flow-schema-v0.0.5...flow-schema-v0.0.6) (2026-07-20)


### Features

* carry an audio prompt's transcript text ([#30](https://github.com/wavekat/wavekat-flow/issues/30)) ([1e531e4](https://github.com/wavekat/wavekat-flow/commit/1e531e40a353ecba8acfaccb7210bd8338823df5))

## [0.0.5](https://github.com/wavekat/wavekat-flow/compare/flow-schema-v0.0.4...flow-schema-v0.0.5) (2026-07-19)


### Bug Fixes

* name Prompt variants via schema titles ([#28](https://github.com/wavekat/wavekat-flow/issues/28)) ([4318260](https://github.com/wavekat/wavekat-flow/commit/4318260faebffad8460503f4789951002dcd4863))

## [0.0.4](https://github.com/wavekat/wavekat-flow/compare/flow-schema-v0.0.3...flow-schema-v0.0.4) (2026-07-19)


### Bug Fixes

* keep ajv codegen out of flow-schema barrel ([#26](https://github.com/wavekat/wavekat-flow/issues/26)) ([be38c3e](https://github.com/wavekat/wavekat-flow/commit/be38c3e9534f12d38d66a70106c3025091c2796d))

## [0.0.3](https://github.com/wavekat/wavekat-flow/compare/flow-schema-v0.0.2...flow-schema-v0.0.3) (2026-07-19)


### Bug Fixes

* avoid JSON import attributes in dist ([#24](https://github.com/wavekat/wavekat-flow/issues/24)) ([33fdfb5](https://github.com/wavekat/wavekat-flow/commit/33fdfb56433853c6196e9f9d11d315acae121046))

## [0.0.2](https://github.com/wavekat/wavekat-flow/compare/flow-schema-v0.0.1...flow-schema-v0.0.2) (2026-07-19)


### Bug Fixes

* ship READMEs with published packages ([#18](https://github.com/wavekat/wavekat-flow/issues/18)) ([7001290](https://github.com/wavekat/wavekat-flow/commit/7001290e19d5fdf665835e72ecde4762f90815fe))

## 0.0.1 (2026-07-19)


### Features

* make both packages publishable ([#12](https://github.com/wavekat/wavekat-flow/issues/12)) ([2d8c29d](https://github.com/wavekat/wavekat-flow/commit/2d8c29d495c9354a672e4ab9d28e8e36d28c55fd))
* port TS mutate (comment-preserving edits) ([#8](https://github.com/wavekat/wavekat-flow/issues/8)) ([9b0af39](https://github.com/wavekat/wavekat-flow/commit/9b0af39e6b243b828a66c790142ad012d712e258))
* port TS validator + wire semantic corpus ([#1](https://github.com/wavekat/wavekat-flow/issues/1)) ([8e4ed5b](https://github.com/wavekat/wavekat-flow/commit/8e4ed5b1312d51a61d8c8e7f04a4cf0ab6c5c11c))
* SSOT schema, conformance corpus, dual codegen ([a753604](https://github.com/wavekat/wavekat-flow/commit/a753604d49eeb32a80de582aa17a6553651c4d27))
