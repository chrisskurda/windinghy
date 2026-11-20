#!/usr/bin/env python3
"""Make a FreeRDP install self-contained: copy every non-system dylib it needs
(recursively) into <prefix>/lib, rewrite install names to @rpath, and ad-hoc sign.

usage: relocate-dylibs.py <prefix>
"""
import os, re, shutil, subprocess, sys

prefix = os.path.abspath(sys.argv[1])
bin_dir, lib_dir = os.path.join(prefix, "bin"), os.path.join(prefix, "lib")
SYSTEM = ("/usr/lib/", "/System/")

def deps(path):
    out = subprocess.run(["otool", "-L", path], capture_output=True, text=True, check=True).stdout
    return [l.split()[0] for l in out.splitlines()[1:] if l.strip()]

def rpaths(path):
    out = subprocess.run(["otool", "-l", path], capture_output=True, text=True, check=True).stdout
    return re.findall(r"cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.+?) \(offset", out)

def run(*a):
    r = subprocess.run(a, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("failed: %s\n%s" % (" ".join(a), r.stderr.strip()))

def is_external(d):
    return not d.startswith(SYSTEM) and not d.startswith("@rpath/")

origin = {}  # copied dylib -> the real file it came from (to resolve @loader_path deps)

# Collect: executables and every dylib already in lib (real files only)
targets = [os.path.join(bin_dir, f) for f in os.listdir(bin_dir)]
targets += [os.path.join(lib_dir, f) for f in os.listdir(lib_dir)
            if f.endswith(".dylib") and not os.path.islink(os.path.join(lib_dir, f))]
queue, seen = list(targets), set()
while queue:
    t = queue.pop()
    if t in seen:
        continue
    seen.add(t)
    for d in deps(t):
        if d.startswith("@rpath/") and t in origin and not os.path.exists(os.path.join(lib_dir, os.path.basename(d))):
            # A copied library finding its sibling through its own original rpaths.
            odir = os.path.dirname(origin[t])
            cands = [os.path.join(r.replace("@loader_path", odir), os.path.basename(d)) for r in rpaths(origin[t])]
            cands.append(os.path.join(odir, os.path.basename(d)))
            src = next((c for c in cands if os.path.exists(c)), None)
            if src is None:
                sys.exit("can't resolve %s needed by %s" % (d, origin[t]))
            dest = os.path.join(lib_dir, os.path.basename(d))
            shutil.copy2(os.path.realpath(src), dest)
            os.chmod(dest, 0o755)
            origin[dest] = os.path.realpath(src)
            queue.append(dest)
            continue
        if not is_external(d):
            continue
        if d.startswith("@loader_path/"):
            if t not in origin:
                continue  # one of our own libraries already pointing at lib/
            real = os.path.realpath(os.path.join(os.path.dirname(origin[t]), d[len("@loader_path/"):]))
        else:
            real = os.path.realpath(d)
        dest = os.path.join(lib_dir, os.path.basename(d))
        if not os.path.exists(dest):
            shutil.copy2(real, dest)
            os.chmod(dest, 0o755)
            origin[dest] = real
            queue.append(dest)

# Rewrite references and ids
for t in list(seen):
    if t.startswith(lib_dir):
        run("install_name_tool", "-id", "@rpath/" + os.path.basename(t), t)
    for d in deps(t):
        if is_external(d):
            run("install_name_tool", "-change", d, "@rpath/" + os.path.basename(d), t)
    want = "@loader_path/../lib"
    have = rpaths(t)
    for r in have:
        if r != want:
            run("install_name_tool", "-delete_rpath", r, t)
    if want not in rpaths(t):
        run("install_name_tool", "-add_rpath", want, t)
    run("codesign", "--force", "--sign", "-", t)

bad = [(t, d) for t in seen for d in deps(t) if is_external(d)]
if bad:
    sys.exit("unrelocated dependencies: %r" % bad[:5])
print("relocated %d files; no external dependencies left" % len(seen))
