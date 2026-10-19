# Public portrait gallery data

This directory supplies real photographs for the independent Q MCP gallery
example. It is a local interoperability sample, not an endorsement by the
photographed people, photographers, or Wikimedia. No face recognition, generated
people, private accounts, or explicit sexual content is used.

## Data and attribution

`manifest.json` has `version: 1` and a `photos` array. Each record identifies a
local file under `photos/`, its SHA-256, dimensions, MIME type, Commons file page,
original image URL, downloaded thumbnail URL, creator, requested credit line,
image license, and license URL. It also records the Commons subject category and
the photograph date used to establish adulthood. The `attribution` field is the
source's requested credit line when one is supplied; otherwise it is `author`.

The bundled collection contains **300 distinct photographs of 55 adult women,
with no more than six photographs per person**. All 300 files were fully decoded
and visually reviewed. The images total **18,332,136 bytes (18.33 MB)**, the
largest dimension is **719 pixels**, and the smallest conservatively documented
age at capture is **20**. There are 274 JPEGs and 26 PNGs. `verification.json`
records the checks and the final manifest checksum.

The validator checks counts, dimensions, file hashes and distinct original
sources against the actual files. A different crop, filename, or thumbnail size
of the same source photograph is not counted as another photograph. The 42
recorded visual exclusions in `exclusions.json` prevent unsuitable framing from
being reintroduced when collection is resumed.

Collection date: **2026-10-19 UTC**. Per-file retrieval timestamps are in the
manifest. Source pages can subsequently change; the saved file hash identifies
the exact bytes in this sample.

Images retain their individual licenses; they are **not** relicensed under the
application's software license. To display a photograph, show its title,
`attribution` (or `author`), the `license` linked to `license_url`, and a source
link to `source_url`. Preserve `modifications` when reusing the image. For
CC BY-SA images, follow the linked share-alike terms if making adaptations.
Public availability and copyright permission do not imply the subject endorses
the application. This sample does not grant a model release for advertising.

All stored image bytes are the existing Wikimedia-served thumbnails, unchanged
by Q. The Commons HTML descriptions are the provenance source; image authors
are taken from the file's author metadata rather than assuming the uploader is
the creator. Structured Commons metadata is CC0; copied Commons description
text is additionally available under CC BY-SA 4.0, with the corresponding
Commons page linked in every record.

References:

- [Commons reuse guidance](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia)
- [Commons credit lines](https://commons.wikimedia.org/wiki/Commons:Credit_line)
- [Commons licensing](https://commons.wikimedia.org/wiki/Commons:Licensing)
- [Commons robots rules](https://commons.wikimedia.org/robots.txt)
- [Upload server robots rules](https://upload.wikimedia.org/robots.txt)
- [Wikimedia User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy)
- [MediaWiki API etiquette](https://www.mediawiki.org/wiki/API:Etiquette)

## Collection method

`collect.py` uses an explicit set of named public Commons subject categories,
then their year categories and file-description pages. It does not identify
people from faces or crawl arbitrary links. Adulthood is based on the source's
birth year and the file's photograph year: `photograph_year - birth_year - 1`
must be at least 18, so the calculation remains valid before that year's
birthday. Undated or inconsistent records are excluded.

The collector follows crawlable `/wiki/Category:` and `/wiki/File:` pages. It
does not crawl the `/w/`, `/api/`, `Special:` or upload-archive paths disallowed
by robots rules. `thumb.wikimedia.org/robots.txt` returned an HTML landing page
without robots directives when checked. Only HTTPS Wikimedia origins are used.
Requests are serial, at least one second apart, and use a descriptive bot
User-Agent. HTTP 429/503 responses trigger bounded waits respecting
`Retry-After`; persistent failures are skipped, never bypassed. No credentials
or API keys are needed.

File titles identifying crops, retouches, enhanced derivatives, groups,
children, or explicit nudity are excluded. Source URLs, original URLs, upstream
photo identifiers where available, SHA-256 hashes, and perceptual hashes help
avoid duplicate images. Every retained file is decoded with Pillow; MIME,
dimensions, byte size, and filename are checked. Visual review is a separate
step from these metadata checks.

## Use and verification

Install Python 3.11+ with Pillow and lxml in your chosen environment. Run from
the repository root:

```sh
python3 backend/examples/beauty-gallery-data/collect.py verify
```

The example server should read this manifest and serve only the named local
files through its standard MCP resources. Reading a photograph never requires
Q to fetch an arbitrary URL supplied by a plugin or a model.

To restore a missing file from the recorded source, without replacing existing
files or silently accepting changed upstream content:

```sh
python3 backend/examples/beauty-gallery-data/collect.py download
```

To build or resume a collection using the explicit source list:

```sh
python3 backend/examples/beauty-gallery-data/collect.py collect
```

Existing complete collections are preserved. A fresh collection can differ as
Commons pages evolve. `.cache/` contains temporary page and robots snapshots;
`qa/` is reserved for local visual-review artifacts. Neither is committed or
served by the example.
