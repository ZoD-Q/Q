#!/usr/bin/env python3
"""Verify, preview, install or roll back the dedicated Q Beauty gallery release."""
import argparse
from contextlib import contextmanager
import difflib
import fcntl
import grp
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import types
import urllib.request

BASE = "https://q.kaicloudpay.com/plugins/beauty/"
ROOT = Path("/opt/q-beauty")
BACKUPS = Path("/var/backups/q-beauty")
NGINX = Path("/etc/nginx/conf.d/q-api-domain.conf")
API_CURRENT = Path("/opt/q/current")
# Match the receiver -> admin lock order before taking the gallery lock.
DEPLOY_LOCKS = (
    (Path("/run/lock/q-ci-deploy.lock"), True),
    (Path("/var/lock/q-admin-demo.lock"), False),
    (Path("/run/lock/q-beauty-deploy.lock"), True),
)
UNCHECKED = object()
UNITS = ("q-beauty.service", "q-beauty-health.service", "q-beauty-health.timer")
JOURNAL = "journald@q-beauty.conf"
DEPLOY_FILES = {*UNITS, JOURNAL, "health-check.py", "nginx-location.conf"}
MANAGED_FILES = {
    "q-api-domain.conf": NGINX,
    **{name: Path("/etc/systemd/system") / name for name in UNITS},
    JOURNAL: Path("/etc/systemd") / JOURNAL,
}
PEER_GUARD = (
    "if ($q_internal_http_peer = 0) { return 308 "
    "https://q.kaicloudpay.com$request_uri; }"
)
RATE_BLOCK = (
    "# BEGIN Q BEAUTY RATE LIMIT\n"
    "limit_req_zone $binary_remote_addr zone=q_beauty_per_ip:1m rate=10r/s;\n"
    "# END Q BEAUTY RATE LIMIT\n"
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        raise ValueError("Local health endpoint must not redirect")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def verify_archive(path, expected_commit, expected_sha):
    """Read a small, exact inventory before creating any installation files."""
    require(re.fullmatch(r"[0-9a-f]{40}", expected_commit), "Expected commit must be 40 hex digits")
    require(re.fullmatch(r"[0-9a-f]{64}", expected_sha), "Archive SHA256 is required")
    require(path.is_file() and not path.is_symlink(), "Archive must be a regular file")
    require(path.stat().st_size <= 64 * 1024 * 1024, "Archive exceeds 64 MiB")
    archive_bytes = path.read_bytes()
    require(sha256(archive_bytes) == expected_sha, "Archive checksum mismatch")
    files = {}
    seen = set()
    total = 0
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
        for index, member in enumerate(archive):
            require(index < 400, "Too many archive entries")
            name = member.name.rstrip("/")
            require(name not in seen, "Duplicate archive entry")
            seen.add(name)
            parts = PurePosixPath(name).parts
            require(
                parts and parts[0] == "q-beauty-release"
                and all(part not in ("", ".", "..") for part in parts)
                and "\\" not in name and name == "/".join(parts),
                "Unsafe archive path",
            )
            if member.isdir():
                require(name in {
                    "q-beauty-release", "q-beauty-release/bin", "q-beauty-release/data",
                    "q-beauty-release/data/photos", "q-beauty-release/deploy",
                }, "Unknown archive directory")
                continue
            require(member.isfile() and not member.issparse(), "Only regular files are allowed")
            require(0 <= member.size <= 32 * 1024 * 1024, "Oversized release file")
            total += member.size
            require(total <= 64 * 1024 * 1024, "Expanded release exceeds 64 MiB")
            relative = "/".join(parts[1:])
            require(relative, "Archive root cannot be a file")
            source = archive.extractfile(member)
            require(source is not None, "Unreadable archive member")
            files[relative] = source.read()
    fixed = {
        "SOURCE_COMMIT", "RELEASE.json", "SHA256SUMS", "bin/beauty_mcp",
        "data/manifest.json", "data/README.md", "data/verification.json",
        *{f"deploy/{name}" for name in DEPLOY_FILES},
    }
    require(fixed <= files.keys(), "Missing required release files")
    require(files["SOURCE_COMMIT"] == (expected_commit + "\n").encode(), "Source commit mismatch")
    metadata = json.loads(files["RELEASE.json"])
    require(metadata == {
        "schema_version": 1, "source_commit": expected_commit,
        "target": "x86_64-unknown-linux-gnu", "public_base": BASE,
        "photo_count": 300, "manifest_sha256": sha256(files["data/manifest.json"]),
    }, "Release metadata mismatch")
    manifest = json.loads(files["data/manifest.json"])
    require(manifest["version"] == 1 and len(manifest["photos"]) == 300,
            "A release requires exactly 300 photos")
    photo_paths = set()
    photo_ids = set()
    for photo in manifest["photos"]:
        filename = photo["filename"]
        require(re.fullmatch(r"photos/[A-Za-z0-9_-][A-Za-z0-9._-]*", filename),
                "Unsafe photo filename")
        path = "data/" + filename
        require(path not in photo_paths and photo["id"] not in photo_ids, "Duplicate photo")
        photo_paths.add(path)
        photo_ids.add(photo["id"])
        require(path in files and 0 < len(files[path]) <= 768 * 1024, "Missing or oversized photo")
        if "sha256" in photo:
            require(sha256(files[path]) == photo["sha256"], "Photo checksum mismatch")
        if "bytes" in photo:
            require(len(files[path]) == photo["bytes"], "Photo size mismatch")
        for field in ("source_url", "author", "license", "license_url", "adult_basis"):
            require(isinstance(photo.get(field), str) and photo[field], "Missing photo provenance")
    require(files.keys() == fixed | photo_paths, "Unexpected release files")
    verification = json.loads(files["data/verification.json"])
    require(verification.get("photo_count") == 300
            and verification.get("manifest_sha256") == metadata["manifest_sha256"],
            "Gallery verification mismatch")
    sums = "".join(
        f"{sha256(data)}  {name}\n" for name, data in sorted(files.items())
        if name != "SHA256SUMS"
    ).encode()
    require(files["SHA256SUMS"] == sums, "Release checksum inventory mismatch")
    binary = files["bin/beauty_mcp"]
    require(len(binary) >= 64 and binary[:7] == b"\x7fELF\x02\x01\x01"
            and int.from_bytes(binary[18:20], "little") == 62
            and int.from_bytes(binary[16:18], "little") in (2, 3),
            "Release binary must be Linux x86-64 ELF")
    return files


def nginx_servers(text):
    """Locate top-level server blocks without interpreting quoted/comment braces."""
    stack = []
    start = 0
    quote = None
    comment = False
    escaped = False
    blocks = []
    for position, char in enumerate(text):
        if comment:
            if char == "\n":
                comment = False
                if not stack:
                    start = position + 1
            continue
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
        elif char == "#":
            comment = True
        elif char == "{":
            token = text[start:position].strip()
            stack.append((token, position))
            start = position + 1
        elif char == "}":
            require(stack, "Unbalanced Nginx configuration")
            token, opening = stack.pop()
            if not stack and token == "server":
                blocks.append((opening, position))
            start = position + 1
        elif char == ";":
            start = position + 1
    require(not stack and quote is None, "Unbalanced Nginx configuration")
    return blocks


def render_nginx(original, template):
    require(original.count("# BEGIN Q BEAUTY GALLERY") in (0, 2)
            and original.count("# BEGIN Q BEAUTY GALLERY")
            == original.count("# END Q BEAUTY GALLERY"), "Partial managed gallery configuration")
    require(original.count("# BEGIN Q BEAUTY RATE LIMIT") in (0, 1)
            and original.count("# BEGIN Q BEAUTY RATE LIMIT")
            == original.count("# END Q BEAUTY RATE LIMIT"), "Partial rate-limit configuration")
    clean = re.sub(
        r"(?m)^    # BEGIN Q BEAUTY GALLERY\n.*?^    # END Q BEAUTY GALLERY\n",
        "", original, flags=re.S,
    )
    clean = re.sub(
        r"(?m)^# BEGIN Q BEAUTY RATE LIMIT\n.*?^# END Q BEAUTY RATE LIMIT\n",
        "", clean, flags=re.S,
    )
    require("/plugins/beauty" not in clean and "q_beauty_per_ip" not in clean,
            "Existing unmanaged gallery route; manual review required")
    require(template.count("__HTTP_PEER_GUARD__") == 2, "Invalid gallery route template")
    blocks = nginx_servers(clean)
    require(len(blocks) == 2, "Expected only two servers in dedicated Q domain configuration")
    inserts = []
    ports = set()
    for opening, closing in blocks:
        body = clean[opening + 1:closing]
        require(re.search(r"(?m)^\s*server_name\s+q\.kaicloudpay\.com\s*;", body),
                "Refusing to edit a server for another domain")
        listening = re.findall(r"(?m)^\s*listen\s+(80|443)(?:\s+[^;]*)?;", body)
        require(len(listening) == 1, "Unexpected Q server listener")
        port = listening[0]
        ports.add(port)
        if port == "80":
            require(PEER_GUARD in body and "$q_internal_http_peer" in clean,
                    "Existing HTTP peer guard differs; manual review required")
        block = template.replace("__HTTP_PEER_GUARD__", PEER_GUARD if port == "80" else "")
        inserts.append((closing, block))
    require(ports == {"80", "443"}, "Expected HTTP and HTTPS Q servers")
    for position, block in reversed(inserts):
        clean = clean[:position] + block + clean[position:]
    return RATE_BLOCK + clean


def command(*arguments, check=True):
    return subprocess.run(arguments, check=check, capture_output=True, text=True, timeout=45)


def configuration_bytes(path):
    require(not path.is_symlink(), f"Refusing symlink destination: {path}")
    if not path.exists():
        return None
    require(path.is_file(), f"Configuration is not a regular file: {path}")
    return path.read_bytes()


def require_file_hash(path, expected_hash):
    current = configuration_bytes(path)
    current_hash = sha256(current) if current is not None else None
    require(current_hash == expected_hash, f"Configuration changed since snapshot: {path}")


def write_atomic(path, data, mode=0o644, *, expected_hash=UNCHECKED):
    require(not path.is_symlink(), f"Refusing symlink destination: {path}")
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".q-beauty-", delete=False) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), mode)
            if expected_hash is not UNCHECKED:
                # Cooperating writers are excluded by installation_lock. For
                # uncoordinated writers this detects observed changes, not an
                # atomic compare-and-swap guarantee across this final rename.
                require_file_hash(path, expected_hash)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def unlink_checked(path, expected_hash):
    require_file_hash(path, expected_hash)
    path.unlink(missing_ok=True)


def point_current(target, *, expected_target=UNCHECKED):
    current = ROOT / "current"
    require(not current.exists() or current.is_symlink(), "Current release must be a symlink")
    temporary = ROOT / ".current-new"
    require(not temporary.exists() and not temporary.is_symlink(), "Stale release switch present")
    temporary.symlink_to(target)
    try:
        if expected_target is not UNCHECKED:
            require(previous_target() == expected_target, "Current release changed since snapshot")
        os.replace(temporary, current)
    finally:
        temporary.unlink(missing_ok=True)


def api_health():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open("http://127.0.0.1:18787/health", timeout=5) as response:
        require(response.status == 200, "Existing Q API is not healthy")


def route_health(commit):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    url = "http://127.0.0.1/plugins/beauty/health"
    request = urllib.request.Request(url, headers={"Host": "q.kaicloudpay.com"})
    with opener.open(request, timeout=5) as response:
        require(response.status == 200 and response.geturl() == url,
                "Gallery Nginx route is not healthy")
        body = response.read(4097)
    require(len(body) <= 4096 and json.loads(body) == {
        "status": "ok", "service": "beauty-mcp", "source_commit": commit,
        "photo_count": 300, "public_base": BASE,
    }, "Gallery Nginx route serves the wrong release")


def expected_health(files, commit):
    # Execute only the already hash-checked, reviewed package's local health helper.
    path = ROOT / "current/deploy/health-check.py"
    source = path.read_bytes()
    require(source == files["deploy/health-check.py"], "Health helper changed")
    # Loading from validated bytes avoids importlib's __pycache__ writes inside
    # the release and does not change the interpreter's global cache policy.
    module = types.ModuleType("q_beauty_health")
    module.__file__ = str(path)
    exec(compile(source, str(path), "exec"), module.__dict__)
    for attempt in range(10):
        try:
            module.check(commit)
            return
        except Exception:
            if attempt == 9:
                raise
            time.sleep(1)


def previous_target():
    current = ROOT / "current"
    if not current.exists() and not current.is_symlink():
        return None
    require(current.is_symlink(), "Current release is not a symlink")
    target = str(current.resolve(strict=True))
    require(re.fullmatch(re.escape(str(ROOT / "releases")) + r"/[0-9a-f]{40}", target),
            "Current release points outside managed releases")
    return target


def preflight():
    require(os.geteuid() == 0, "Install/rollback must run as root")
    require(sys.platform == "linux", "Install/rollback requires Linux")
    require(os.uname().machine == "x86_64", "Install/rollback requires Linux amd64")
    require(NGINX.is_file() and not NGINX.is_symlink(), "Dedicated Q Nginx file is required")
    for path in MANAGED_FILES.values():
        require(not path.is_symlink(), f"Managed configuration cannot be a symlink: {path}")
    command("nginx", "-t")
    api_health()


def service_state(name):
    active = command("systemctl", "is-active", name, check=False).stdout.strip()
    enabled = command("systemctl", "is-enabled", name, check=False).stdout.strip()
    require(active not in ("activating", "deactivating") and enabled != "masked",
            "Gallery service is changing state or masked")
    return {"active": active == "active", "enabled": enabled in ("enabled", "enabled-runtime")}


def backup(changes, commit, originals):
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(not BACKUPS.is_symlink() and BACKUPS.stat().st_uid == 0
            and BACKUPS.stat().st_mode & 0o077 == 0, "Backup root must be private and root owned")
    destination = Path(tempfile.mkdtemp(
        prefix=time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + commit[:12] + "-",
        dir=BACKUPS,
    ))
    state = {
        "schema_version": 1, "source_commit": commit, "previous_target": previous_target(),
        "installed_target": str(ROOT / "releases" / commit),
        "services": {name: service_state(name) for name in ("q-beauty.service", "q-beauty-health.timer")},
        "files": {}, "complete": False,
    }
    for name, path in MANAGED_FILES.items():
        # Preserve exactly the bytes used to render the new configuration.
        old = originals[name]
        require_file_hash(path, sha256(old) if old is not None else None)
        if old is not None:
            (destination / name).write_bytes(old)
        state["files"][name] = {
            "previous_sha256": sha256(old) if old is not None else None,
            "installed_sha256": sha256(changes[name]),
            "mode": path.stat().st_mode & 0o777 if old is not None else 0o644,
        }
    write_atomic(destination / "state.json", json.dumps(state, indent=2).encode() + b"\n", 0o600)
    return destination, state


def restore(destination, state, internal=False):
    require(destination.parent == BACKUPS and destination.is_dir()
            and not destination.is_symlink() and destination.stat().st_uid == 0
            and destination.stat().st_mode & 0o077 == 0, "Invalid backup directory")
    require(state["schema_version"] == 1 and state["files"].keys() == MANAGED_FILES.keys(),
            "Invalid backup inventory")
    require(re.fullmatch(r"[0-9a-f]{40}", state["source_commit"])
            and state["installed_target"] == str(ROOT / "releases" / state["source_commit"]),
            "Invalid backup release identity")
    require(state["previous_target"] is None or re.fullmatch(
        re.escape(str(ROOT / "releases")) + r"/[0-9a-f]{40}", state["previous_target"]
    ), "Invalid previous release identity")
    require(state["services"].keys() == {"q-beauty.service", "q-beauty-health.timer"},
            "Unexpected service in backup")
    current_target = previous_target()
    require(current_target in (state["installed_target"], state["previous_target"]),
            "Current release changed since this backup")
    observed_hashes = {}
    previous_bytes = {}
    for name, path in MANAGED_FILES.items():
        item = state["files"][name]
        current = configuration_bytes(path)
        present = sha256(current) if current is not None else None
        accepted = {item["installed_sha256"]}
        if internal:
            accepted.add(item["previous_sha256"])
        require(present in accepted, f"Configuration changed since deployment: {path}")
        observed_hashes[name] = present
        if item["previous_sha256"] is not None:
            previous_bytes[name] = (destination / name).read_bytes()
            require(sha256(previous_bytes[name]) == item["previous_sha256"],
                    "Backup checksum mismatch")
    command("systemctl", "stop", "q-beauty-health.timer", "q-beauty-health.service", check=False)
    command("systemctl", "stop", "q-beauty.service", check=False)
    command("systemctl", "disable", "q-beauty.service", "q-beauty-health.timer", check=False)
    for name, path in MANAGED_FILES.items():
        item = state["files"][name]
        if item["previous_sha256"] is None:
            unlink_checked(path, observed_hashes[name])
        else:
            write_atomic(path, previous_bytes[name], item["mode"], expected_hash=observed_hashes[name])
    if state["previous_target"] is None:
        require(previous_target() == current_target, "Current release changed since snapshot")
        (ROOT / "current").unlink(missing_ok=True)
    else:
        point_current(state["previous_target"], expected_target=current_target)
    command("systemctl", "daemon-reload")
    for name, previous in state["services"].items():
        if previous["enabled"]:
            command("systemctl", "enable", name)
        if previous["active"]:
            command("systemctl", "start", name)
    command("nginx", "-t")
    command("systemctl", "reload", "nginx")
    if state["previous_target"] is not None and state["services"]["q-beauty.service"]["active"]:
        previous_commit = Path(state["previous_target"]).name
        for attempt in range(10):
            try:
                route_health(previous_commit)
                break
            except Exception:
                if attempt == 9:
                    raise
                time.sleep(1)
    api_health()
    print(f"Rollback restored configuration and service state from {destination}")


@contextmanager
def installation_lock():
    """Serialize with Q CI/admin deployers; manual writers must use these locks too."""
    descriptors = []
    try:
        for path, private in DEPLOY_LOCKS:
            descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_CREAT, 0o600)
            descriptors.append(descriptor)
            info = os.fstat(descriptor)
            require(info.st_uid == 0 and stat.S_ISREG(info.st_mode)
                    and not info.st_mode & (0o077 if private else 0o022),
                    f"Untrusted deployment lock: {path}")
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def install(files, commit):
    preflight()
    old_target = previous_target()
    for name in (*UNITS, JOURNAL):
        path = MANAGED_FILES[name]
        require(not path.exists() or old_target is not None, "Unmanaged gallery unit already exists")
    if old_target is None:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 18796))
    try:
        account = pwd.getpwnam("q-beauty")
        require(account.pw_uid != 0 and account.pw_shell in ("/usr/sbin/nologin", "/sbin/nologin"),
                "Existing q-beauty user is not a restricted service identity")
        require(os.getgrouplist("q-beauty", account.pw_gid) == [account.pw_gid],
                "Service identity has unexpected group memberships")
        require(grp.getgrnam("q-beauty").gr_gid == account.pw_gid,
                "Service group does not match the restricted identity")
    except KeyError:
        command("useradd", "--system", "--user-group", "--no-create-home",
                "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", "q-beauty")
    ROOT.mkdir(mode=0o755, parents=True, exist_ok=True)
    require(not ROOT.is_symlink() and ROOT.stat().st_uid == 0
            and ROOT.stat().st_mode & 0o022 == 0, "Release root must be root owned")
    releases = ROOT / "releases"
    releases.mkdir(mode=0o755, exist_ok=True)
    require(not releases.is_symlink() and releases.stat().st_uid == 0
            and releases.stat().st_mode & 0o022 == 0, "Release directory must be root owned")
    target = releases / commit
    if target.exists():
        require(not target.is_symlink(), "Release cannot be a symlink")
        require(all(not path.is_symlink() and path.stat().st_uid == 0
                    and path.stat().st_mode & 0o022 == 0
                    for path in [target, *target.rglob("*")]), "Existing release is not immutable")
        existing = {str(path.relative_to(target)) for path in target.rglob("*") if path.is_file()}
        require(existing == files.keys(), "Existing release inventory differs")
        for name, data in files.items():
            path = target / name
            require(not path.is_symlink() and path.read_bytes() == data, "Existing release differs")
    else:
        staging = Path(tempfile.mkdtemp(prefix=".incoming-", dir=releases))
        try:
            for name, data in files.items():
                path = staging / name
                path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                path.write_bytes(data)
                path.chmod(0o555 if name in ("bin/beauty_mcp", "deploy/health-check.py") else 0o444)
            staging.chmod(0o755)
            os.replace(staging, target)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    originals = {name: configuration_bytes(path) for name, path in MANAGED_FILES.items()}
    require(originals["q-api-domain.conf"] is not None, "Dedicated Q Nginx file disappeared")
    original = originals["q-api-domain.conf"].decode()
    changes = {
        "q-api-domain.conf": render_nginx(original, files["deploy/nginx-location.conf"].decode()).encode(),
        **{name: files[f"deploy/{name}"] for name in (*UNITS, JOURNAL)},
    }
    destination, state = backup(changes, commit, originals)
    api_target = API_CURRENT.resolve(strict=True)
    print(f"Rollback backup: {destination}", flush=True)
    try:
        command("systemctl", "stop", "q-beauty-health.timer", "q-beauty-health.service", check=False)
        for name in (*UNITS, JOURNAL):
            write_atomic(
                MANAGED_FILES[name], changes[name], state["files"][name]["mode"],
                expected_hash=state["files"][name]["previous_sha256"],
            )
        point_current(str(target), expected_target=state["previous_target"])
        command("systemd-analyze", "verify", *[str(MANAGED_FILES[name]) for name in UNITS])
        command("systemctl", "daemon-reload")
        command("systemctl", "enable", "q-beauty.service", "q-beauty-health.timer")
        command("systemctl", "restart", "q-beauty.service")
        expected_health(files, commit)
        write_atomic(
            NGINX, changes["q-api-domain.conf"], state["files"]["q-api-domain.conf"]["mode"],
            expected_hash=state["files"]["q-api-domain.conf"]["previous_sha256"],
        )
        command("nginx", "-t")
        command("systemctl", "reload", "nginx")
        route_health(commit)
        api_health()
        require(API_CURRENT.resolve(strict=True) == api_target, "Q API release changed")
        command("systemctl", "start", "q-beauty-health.timer")
        state["complete"] = True
        write_atomic(destination / "state.json", json.dumps(state, indent=2).encode() + b"\n", 0o600)
    except BaseException:
        restore(destination, state, internal=True)
        raise
    print(f"Gallery installed: {commit}\nCard: {BASE}server-card.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    for action in ("verify", "plan", "install"):
        sub = actions.add_parser(action)
        sub.add_argument("archive", type=Path)
        sub.add_argument("--expected-commit", required=True)
        sub.add_argument("--archive-sha256", required=True)
    rollback = actions.add_parser("rollback")
    rollback.add_argument("backup", type=Path)
    args = parser.parse_args()
    if args.action == "rollback":
        preflight()
        with installation_lock():
            state = json.loads((args.backup / "state.json").read_text())
            restore(args.backup, state)
        return
    files = verify_archive(args.archive, args.expected_commit, args.archive_sha256)
    print(f"Verified immutable release {args.expected_commit}: 300 photos, {len(files)} files")
    if args.action == "verify":
        return
    if args.action == "plan":
        original = NGINX.read_text()
        result = render_nginx(original, files["deploy/nginx-location.conf"].decode())
        print("".join(difflib.unified_diff(
            original.splitlines(keepends=True), result.splitlines(keepends=True),
            fromfile=str(NGINX), tofile=str(NGINX) + " (planned)",
        )), end="")
        print(f"Dedicated service: q-beauty; 127.0.0.1:18796; {ROOT}/releases/{args.expected_commit}")
        return
    with installation_lock():
        install(files, args.expected_commit)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Gallery operation failed: {error}", file=sys.stderr)
        sys.exit(1)
