#!/usr/bin/env python3
"""Collect a small, attributed Commons photo corpus from crawlable public pages.

Requires Pillow and lxml. No API keys, cookies, browser impersonation, image
generation, or face identification. The original downloaded bytes are preserved.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import time
import unicodedata
from collections import Counter
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.robotparser import RobotFileParser

from lxml import html
from PIL import Image

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / '.cache'
PHOTOS = ROOT / 'photos'
AGENT = 'QGalleryFixtureBot/1.0 (one-time licensed Commons photo collection for local Q MCP interoperability testing)'
COMMONS = 'https://commons.wikimedia.org'
DELAY = 1.0
LAST_REQUEST = 0.0
ROBOTS: dict[str, RobotFileParser] = {}
ALLOWED_HOSTS = {'commons.wikimedia.org', 'upload.wikimedia.org', 'thumb.wikimedia.org'}
MAX_BYTES = 1_500_000
Image.MAX_IMAGE_PIXELS = 8_000_000


class CollectionPaused(RuntimeError):
    """Stop the entire collection rather than work around a rate restriction."""


class WikimediaRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        parsed = urlsplit(newurl)
        if parsed.scheme != 'https' or parsed.hostname not in ALLOWED_HOSTS or parsed.username:
            raise ValueError('Unexpected redirect origin')
        return super().redirect_request(request, fp, code, msg, headers, newurl)


OPENER = build_opener(WikimediaRedirects())

# Names seed source-category discovery only; identity comes from Commons text,
# never image recognition. Date of birth is independently read from each category.
SUBJECTS = [
    'Emma Stone', 'Scarlett Johansson', 'Natalie Portman', 'Anne Hathaway',
    'Jennifer Lawrence', 'Jessica Chastain', 'Amy Adams', 'Rachel McAdams',
    'Emily Blunt', 'Keira Knightley', 'Cate Blanchett', 'Kate Winslet',
    'Charlize Theron', 'Nicole Kidman', 'Sandra Bullock', 'Julia Roberts',
    'Angelina Jolie', 'Penélope Cruz', 'Salma Hayek', 'Marion Cotillard',
    'Léa Seydoux', 'Eva Green', 'Diane Kruger', 'Alicia Vikander',
    'Rebecca Ferguson', 'Rosamund Pike', 'Lily James', 'Felicity Jones',
    'Dakota Johnson', 'Margot Robbie', 'Gal Gadot', 'Ana de Armas',
    'Rachel Weisz', 'Eva Mendes', 'Naomi Watts', 'Halle Berry', 'Lucy Liu',
    'Michelle Yeoh', 'Zhang Ziyi', 'Gong Li', 'Fan Bingbing', 'Li Bingbing',
    'Tang Wei', 'Liu Yifei', 'Ni Ni', 'Deepika Padukone', 'Priyanka Chopra',
    'Aishwarya Rai', 'Kareena Kapoor', 'Katrina Kaif', 'Anushka Sharma',
    'Sonam Kapoor', 'Sonakshi Sinha', 'Miranda Kerr', 'Adriana Lima',
    'Alessandra Ambrosio', 'Gisele Bündchen', 'Heidi Klum', 'Karlie Kloss',
    'Doutzen Kroes', 'Liu Wen', 'Irina Shayk', 'Rosie Huntington-Whiteley',
    'Candice Swanepoel', 'Taylor Swift', 'Rihanna', 'Beyoncé', 'Dua Lipa',
    'Kacey Musgraves', 'Lana Del Rey', 'Lady Gaga', 'Shakira', 'Celine Dion',
    'Alicia Keys', 'Norah Jones', 'Adele', 'Katie Melua', 'Katy Perry',
    'Kristen Stewart', 'Daisy Ridley', 'Elizabeth Olsen', 'Brie Larson',
    'Tessa Thompson', 'Zoe Saldaña', 'Janelle Monáe', 'Lupita Nyong’o',
]
CATEGORY_NAMES = {'Anne Hathaway': 'Anne Hathaway (actress)', 'Rebecca Ferguson': 'Rebecca Ferguson (actress)', 'Lupita Nyong’o': "Lupita Nyong'o"}


def clean_text(element) -> str:
    return ' '.join(element.text_content().split()) if element is not None else ''


def normal(value: str) -> str:
    return ''.join(c for c in unicodedata.normalize('NFKD', value).casefold()
                   if not unicodedata.combining(c))


def canonical(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, '', ''))


def raw_fetch(url: str, limit: int = 5_000_000) -> tuple[bytes, str]:
    global LAST_REQUEST
    if urlsplit(url).scheme != 'https' or urlsplit(url).hostname not in ALLOWED_HOSTS:
        raise ValueError('Unexpected collection origin')
    for attempt in range(4):
        time.sleep(max(0, DELAY - (time.monotonic() - LAST_REQUEST)))
        LAST_REQUEST = time.monotonic()
        try:
            with OPENER.open(Request(url, headers={'User-Agent': AGENT}), timeout=25) as response:
                if urlsplit(response.url).hostname not in ALLOWED_HOSTS:
                    raise ValueError('Unexpected redirect origin')
                data = response.read(limit + 1)
                if len(data) > limit:
                    raise ValueError('Response exceeds collection limit')
                return data, response.headers.get_content_type()
        except HTTPError as error:
            if error.code == 403:
                raise CollectionPaused('Source refused this collector (HTTP 403); collection stopped') from error
            if error.code in (429, 503) and attempt < 3:
                retry_after = error.headers.get('Retry-After', '0')
                try:
                    seconds = int(retry_after)
                except ValueError:
                    try:
                        seconds = max(0, int((parsedate_to_datetime(retry_after) - datetime.now(timezone.utc)).total_seconds()))
                    except (TypeError, ValueError):
                        seconds = 60
                wait = max(10 * (attempt + 1), seconds)
                if wait > 120:
                    raise CollectionPaused(f'Source requested a {wait}s pause; stop and resume later') from error
                print(f'backoff {error.code}: {wait}s', flush=True)
                time.sleep(wait)
                continue
            if error.code == 429:
                raise CollectionPaused('Persistent HTTP 429; collection stopped') from error
            raise
        except (URLError, TimeoutError):
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))
    raise RuntimeError('Unreachable')


def initialize_robots() -> None:
    CACHE.mkdir(exist_ok=True)
    PHOTOS.mkdir(exist_ok=True)
    for host in sorted(ALLOWED_HOSTS):
        data, content_type = raw_fetch(f'https://{host}/robots.txt')
        (CACHE / f'{host}-robots.txt').write_bytes(data)
        parser = RobotFileParser()
        # thumb.wikimedia.org returns a Commons HTML landing page for robots.txt,
        # i.e. no robot directives. Commons' normal /wiki/ pages are allowed;
        # /w/, /api/, Special pages and upload archives are never crawled.
        parser.parse(data.decode('utf-8-sig', errors='replace').splitlines()
                     if content_type == 'text/plain' else [])
        ROBOTS[host] = parser


def fetch_page(url: str):
    url = canonical(url)
    host = urlsplit(url).hostname
    if host != 'commons.wikimedia.org' or not ROBOTS[host].can_fetch(AGENT, url):
        raise ValueError('Page not permitted by robots rules')
    key = hashlib.sha256(url.encode()).hexdigest()
    path = CACHE / f'{key}.html'
    if path.exists():
        data = path.read_bytes()
    else:
        data, content_type = raw_fetch(url)
        if content_type != 'text/html':
            raise ValueError('Expected public HTML page')
        path.write_bytes(data)
    return html.fromstring(data)


def field(page, identifier: str) -> str:
    cells = page.xpath(f'//*[@id="{identifier}"]/following-sibling::td')
    return clean_text(cells[0]) if cells else ''


def credit_line(page, author: str) -> str:
    for row in page.xpath('//table[contains(@class,"fileinfotpl-type-information")]//tr'):
        cells = row.xpath('./td')
        if len(cells) >= 2 and clean_text(cells[0]).startswith('Attribution'):
            return clean_text(cells[1])
    custom = page.xpath('//*[contains(concat(" ",normalize-space(@class)," ")," licensetpl_attr ")]')
    return next((clean_text(x) for x in custom if clean_text(x)), author)


def category_url(name: str) -> str:
    name = CATEGORY_NAMES.get(name, name)
    return COMMONS + '/wiki/Category:' + quote(name.replace(' ', '_'), safe=':_()-')


def birth_details(page) -> tuple[int, str]:
    for row in page.xpath('//*[@id="wdinfobox"]//tr'):
        if 'Date of birth' in ' '.join(row.xpath('./th//text()')):
            value = ' '.join(' '.join(row.xpath('./td//text()')).split())
            match = re.search(r'\b(19\d{2}|200\d)\b', value)
            if match:
                return int(match.group()), value[:match.end()]
    raise ValueError('No source date of birth')


def candidates(subject: str, root, birth_year: int) -> list[tuple[str, int]]:
    earliest = max(2005, birth_year + 20)
    # Browse named public year categories instead of restricted search/API paths.
    links = root.xpath('//*[@id="mw-subcategories"]//a/@href')
    year_root = next((x for x in links if unquote(x).endswith('_by_year')), None)
    years = []
    if year_root:
        annual = fetch_page(urljoin(COMMONS, year_root))
        for link in annual.xpath('//*[@id="mw-subcategories"]//a/@href'):
            match = re.search(r'_in_(20\d{2})$', unquote(link))
            if match and earliest <= int(match.group(1)) <= date.today().year:
                years.append((link, int(match.group(1))))
    for link in links:
        match = re.search(r'_in_(20\d{2})$', unquote(link))
        if match and earliest <= int(match.group(1)) <= date.today().year:
            years.append((link, int(match.group(1))))
    years = sorted(set(years), key=lambda value: value[1], reverse=True)
    found = []
    for link, year in years[:7]:
        annual = fetch_page(urljoin(COMMONS, link))
        files = annual.xpath('//li[contains(@class,"gallerybox")]//a[contains(@class,"galleryfilename")]/@href')
        filtered = []
        for path in files:
            title = unquote(path.split('/wiki/File:', 1)[-1]).replace('_', ' ')
            if not normal(title).startswith(normal(subject)):
                continue
            if re.search(r'crop|retouch|edited|enhanced|derivative|&|\band\b|\bwith\b|\bfamily\b|\bchildren\b|\bnude\b|\bnaked\b|\btopless\b|\blogo\b|\bautograph\b|\bsignature\b', title, re.I):
                continue
            if not re.search(r'\.(jpg|jpeg|png|webp)$', title, re.I):
                continue
            filtered.append((urljoin(COMMONS, path), year))
        # Round-robin across years below prevents a corpus of adjacent burst shots.
        found.append(filtered[:10])
    result = []
    for i in range(10):
        for items in found:
            if i < len(items):
                result.append(items[i])
    return result


def photo_metadata(url: str, subject: str, birth_year: int, birth_text: str, subject_url: str, category_year: int) -> dict:
    page = fetch_page(url)
    article = ' '.join(page.xpath('//*[@id="mw-content-text"]//text()'))
    if any(notice in article for notice in (
        'This media file has been nominated for deletion',
        'This file has been nominated for deletion',
        'This file is a copyright violation',
        'This media file is missing permission',
        'The source of this file is not specified',
    )):
        raise ValueError('Source has an unresolved permission or deletion warning')
    title = clean_text(page.xpath('//h1')[0]).removeprefix('File:')
    author = field(page, 'fileinfotpl_aut')
    taken = field(page, 'fileinfotpl_date')
    caption = field(page, 'fileinfotpl_desc')
    match = re.search(r'\b(19\d{2}|20\d{2})\b', taken)
    if not match:
        raise ValueError('Missing source photograph date')
    shot_year = int(match.group())
    if shot_year != category_year or shot_year - birth_year - 1 < 18:
        raise ValueError('Photograph age/date is not unambiguous')
    if not author or len(author) > 1200 or re.search(r'unknown|anonymous|not provided', author, re.I) or normal(subject) not in normal(title):
        raise ValueError('Missing author or subject provenance')
    if re.search(r'\b(children|child|daughter|son|family|nude|naked|topless)\b', caption, re.I):
        raise ValueError('Out-of-scope content description')
    licenses = []
    for template in page.xpath('//*[contains(concat(" ",normalize-space(@class)," ")," licensetpl ")]'):
        names = template.xpath('.//*[contains(@class,"licensetpl_short")]')
        links = template.xpath('.//*[contains(@class,"licensetpl_link")]')
        name = clean_text(names[0]) if names else ''
        link_text = clean_text(links[0]) if links else ''
        license_url = re.search(r'https?://[^\s<>]+', link_text)
        if re.fullmatch(r'CC BY(?:-SA)? [1-4]\.0', name) and license_url:
            licenses.append((name, license_url.group().replace('http:', 'https:')))
        elif name in ('CC0', 'CC0 1.0'):
            licenses.append(('CC0 1.0', 'https://creativecommons.org/publicdomain/zero/1.0/'))
    if not licenses:
        raise ValueError('No supported clear reusable image license')
    license_name, license_url = licenses[0]
    image = page.xpath('//*[@id="file"]//img')
    originals = page.xpath('//*[@id="file"]//a/@href')
    original_url = next((canonical(x) for x in originals if '/thumb/' not in x and urlsplit(x).hostname == 'upload.wikimedia.org'), None)
    if not image or not original_url:
        raise ValueError('Missing original image or thumbnail')
    displayed_width, displayed_height = int(image[0].get('width')), int(image[0].get('height'))
    thumbs = []
    for item in originals + [image[0].get('src')]:
        if not item:
            continue
        item = canonical(item)
        width = re.search(r'/(\d+)px-', item)
        if width and urlsplit(item).hostname in ALLOWED_HOSTS:
            value = int(width.group(1))
            height = round(value * displayed_height / displayed_width)
            if max(value, height) <= 720 and value >= 200:
                thumbs.append((value, item))
    if not thumbs:
        raise ValueError('No existing thumbnail within size budget')
    thumbnail = max(thumbs)[1]
    attribution_text = credit_line(page, author)
    source_cells = page.xpath('//*[@id="fileinfotpl_src"]/following-sibling::td')
    source_links = source_cells[0].xpath('.//a/@href') if source_cells else []
    origin_identity = original_url
    for link in source_links:
        flickr = re.search(r'flickr\.com/photos/[^/]+/(\d+)', link)
        if flickr:
            origin_identity = 'flickr:' + flickr.group(1)
            break
    return {
        'title': title.rsplit('.', 1)[0], 'source_url': canonical(url),
        'original_url': original_url, 'thumbnail_url': thumbnail, 'author': author,
        'attribution': attribution_text, 'license': license_name, 'license_url': license_url,
        'subject': subject,
        'adult_basis': f'Commons subject category records birth year {birth_year}; file description dates the photograph to {shot_year}. Even before that year’s birthday, the subject was at least {shot_year-birth_year-1}.',
        'subject_source_url': subject_url, 'birth_date_source_text': birth_text,
        'photograph_date_source_text': taken, 'minimum_age_at_capture': shot_year-birth_year-1,
        'description': caption, 'origin_identity': origin_identity,
        'retrieved_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'modifications': 'None by Q. Wikimedia-served thumbnail bytes are stored unchanged.',
    }


def image_info(data: bytes) -> tuple[int, int, str, str]:
    with Image.open(io.BytesIO(data)) as image:
        image.verify()
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        if image.format not in ('JPEG', 'PNG', 'WEBP') or max(image.size) > 720:
            raise ValueError('Image format or dimensions outside collection limits')
        # dHash detects byte-different near-identical images for human review.
        tiny = image.convert('L').resize((9, 8))
        pixels = list(tiny.get_flattened_data() if hasattr(tiny, 'get_flattened_data') else tiny.getdata())
        bits = ''.join('1' if pixels[y*9+x] > pixels[y*9+x+1] else '0' for y in range(8) for x in range(8))
        return *image.size, image.format, f'{int(bits,2):016x}'


def save_manifest(photos: list[dict], failures: list[dict]) -> None:
    target = ROOT / 'manifest.json'
    temporary = CACHE / 'manifest.json.tmp'
    temporary.write_text(json.dumps({'version': 1, 'collected_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'photos': photos}, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(target)
    (CACHE / 'collection-errors.json').write_text(json.dumps(failures, ensure_ascii=False, indent=2) + '\n')


def collect(limit: int) -> None:
    existing = ROOT / 'manifest.json'
    photos = json.loads(existing.read_text())['photos'] if existing.exists() else []
    if len(photos) >= limit:
        verify(limit)
        return
    initialize_robots()
    failures = []
    origins = {p['origin_identity'] for p in photos}
    shas = {p['sha256'] for p in photos}
    seen_urls = {p['source_url'] for p in photos}
    exclusions = ROOT / 'exclusions.json'
    if exclusions.exists():
        seen_urls.update(p['source_url'] for p in json.loads(exclusions.read_text()))
    for subject in SUBJECTS:
        if len(photos) >= limit:
            break
        count = sum(p['subject'] == subject for p in photos)
        if count >= 6:
            continue
        subject_url = category_url(subject)
        try:
            category = fetch_page(subject_url)
            birth_year, birth_text = birth_details(category)
            choices = candidates(subject, category, birth_year)
        except CollectionPaused:
            raise
        except Exception as error:
            failures.append({'subject': subject, 'error': str(error)})
            print(f'{subject}: discovery skipped ({error})', flush=True)
            continue
        for url, year in choices:
            if count >= 6 or len(photos) >= limit:
                break
            if canonical(url) in seen_urls:
                continue
            try:
                record = photo_metadata(url, subject, birth_year, birth_text, subject_url, year)
                if record['origin_identity'] in origins:
                    continue
                if not ROBOTS[urlsplit(record['thumbnail_url']).hostname].can_fetch(AGENT, record['thumbnail_url']):
                    raise ValueError('Thumbnail blocked by robots')
                data, mime = raw_fetch(record['thumbnail_url'], MAX_BYTES)
                if mime not in ('image/jpeg','image/png','image/webp'):
                    raise ValueError('Unexpected thumbnail MIME')
                sha = hashlib.sha256(data).hexdigest()
                if sha in shas:
                    continue
                width, height, fmt, dhash = image_info(data)
                if any((int(dhash,16)^int(p['dhash'],16)).bit_count() <= 3 for p in photos):
                    raise ValueError('Near-duplicate image')
                identifier = f'photo-{len(photos)+1:03d}'
                filename = f'photos/{identifier}.{dict(JPEG="jpg",PNG="png",WEBP="webp")[fmt]}'
                (ROOT / filename).write_bytes(data)
                record.update(id=identifier, filename=filename, width=width, height=height,
                              sha256=sha, dhash=dhash, mime_type=mime, bytes=len(data))
                photos.append(record); origins.add(record['origin_identity']); shas.add(sha); seen_urls.add(record['source_url']); count += 1
                save_manifest(photos, failures)
                print(f'{len(photos):03d}/{limit} {subject}: {record["title"][:75]} ({width}x{height})', flush=True)
            except CollectionPaused:
                raise
            except Exception as error:
                failures.append({'subject': subject, 'url': url, 'error': str(error)})
        print(f'{subject}: {count} collected', flush=True)
    save_manifest(photos, failures)
    print(json.dumps({'photos':len(photos),'subjects':len({p['subject'] for p in photos}),'bytes':sum(p['bytes'] for p in photos)},indent=2),flush=True)


def verify(expected: int) -> None:
    photos = json.loads((ROOT / 'manifest.json').read_text())['photos']
    assert len(photos) == expected, (len(photos), expected)
    required = 'id title filename source_url original_url author license license_url subject adult_basis width height sha256'.split()
    for photo in photos:
        assert all(photo.get(key) for key in required), photo['id']
        assert re.fullmatch(r'photos/photo-\d{3}\.(jpg|png|webp)', photo['filename'])
        data = (ROOT / photo['filename']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == photo['sha256'], photo['id']
        width, height, fmt, dhash = image_info(data)
        assert (width,height,dhash) == (photo['width'],photo['height'],photo['dhash'])
        assert photo['filename'].endswith({'JPEG':'.jpg','PNG':'.png','WEBP':'.webp'}[fmt])
        assert photo['mime_type'] == {'JPEG':'image/jpeg','PNG':'image/png','WEBP':'image/webp'}[fmt]
        assert photo['minimum_age_at_capture'] >= 18
    for key in ('id','filename','source_url','original_url','origin_identity','sha256'):
        assert len({p[key] for p in photos}) == expected, key
    counts = Counter(p['subject'] for p in photos)
    assert {p['filename'] for p in photos} == {str(path.relative_to(ROOT)) for path in PHOTOS.iterdir() if path.is_file()}
    assert max(counts.values()) <= 6
    if expected == 300:
        assert len(counts) >= 50
    total = sum((ROOT / p['filename']).stat().st_size for p in photos)
    assert total <= 60_000_000
    print(json.dumps({'verified':expected,'subjects':len(counts),'maximum_per_subject':max(counts.values()),'bytes':total,'all_decoded':True,'all_source_and_sha_unique':True},indent=2))


def download(expected: int) -> None:
    """Restore exactly the recorded bytes, failing if an upstream file changed."""
    initialize_robots()
    photos = json.loads((ROOT / 'manifest.json').read_text())['photos']
    for photo in photos:
        path = ROOT / photo['filename']
        if path.exists():
            continue
        url = photo['thumbnail_url']
        if not ROBOTS[urlsplit(url).hostname].can_fetch(AGENT, url):
            raise ValueError('Thumbnail blocked by robots')
        data, _ = raw_fetch(url, MAX_BYTES)
        if hashlib.sha256(data).hexdigest() != photo['sha256']:
            raise ValueError(f'Upstream bytes changed: {photo["source_url"]}')
        path.write_bytes(data)
    verify(expected)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=('collect','verify','download'))
    parser.add_argument('--count', type=int, default=300)
    args = parser.parse_args()
    {'collect':collect, 'verify':verify, 'download':download}[args.command](args.count)
