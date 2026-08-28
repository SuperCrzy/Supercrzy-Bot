#!/usr/bin/env python3
"""Duplicate & near-duplicate code block detector for TS/JS sources.

Level 1: exact duplicated blocks (normalized-line n-gram fingerprinting)
Level 2: near-duplicate blocks via token shingling + SequenceMatcher.
Output is clustered: every group of mutually-duplicated locations appears once.
"""
import os, re, hashlib, json
from collections import defaultdict
from difflib import SequenceMatcher

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
WINDOW = 8
EXACT_MIN = 5
SIM_MIN = 5
SIM_THRESHOLD = 0.80
EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}

STR_RE = re.compile(r'([\'"`])(?:\\.|(?!\1).)*\1')
NUM_RE = re.compile(r'\b\d+(?:\.\d+)?\b')
ID_RE = re.compile(r'[A-Za-z_$][A-Za-z0-9_$]*')
WS = re.compile(r'\s+')


def strip_comment(line):
    out, i, n, in_str, str_ch, in_block = [], 0, len(line), None, None, False
    while i < n:
        c = line[i]
        if in_str:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(line[i + 1]); i += 2; continue
            if c == str_ch:
                in_str = False
            i += 1; continue
        if in_block:
            if c == '*' and i + 1 < n and line[i + 1] == '/':
                in_block = False; i += 2; continue
            i += 1; continue
        if c in ('"', "'", '`'):
            in_str = True; str_ch = c; out.append(c); i += 1; continue
        if c == '/' and i + 1 < n and line[i + 1] == '/':
            break
        if c == '/' and i + 1 < n and line[i + 1] == '*':
            in_block = True; i += 2; continue
        out.append(c); i += 1
    return ''.join(out)


def norm_line(line):
    line = strip_comment(line)
    if not line.strip():
        return ""
    line = STR_RE.sub('S', line)
    line = NUM_RE.sub('N', line)
    line = WS.sub(' ', line).strip()
    return line


def tokenize(line):
    return ID_RE.findall(line)


def md5(s):
    return hashlib.md5(s.encode()).hexdigest()


def load_files():
    files, errs = [], []
    for root, _, names in os.walk(SRC):
        for n in names:
            if os.path.splitext(n)[1] in EXT:
                p = os.path.join(root, n)
                try:
                    with open(p, encoding="utf-8") as f:
                        raw = f.read().splitlines()
                    files.append((os.path.relpath(p, SRC), raw))
                except Exception as e:
                    errs.append((p, str(e)))
    return files, errs


def merge_regions(pairs, size):
    regions = []
    used = [False] * len(pairs)
    for i, (a, b) in enumerate(pairs):
        if used[i]:
            continue
        grp = [(a, b)]
        used[i] = True
        changed = True
        while changed:
            changed = False
            for j, (a2, b2) in enumerate(pairs):
                if used[j]:
                    continue
                for (ga, gb) in grp:
                    if abs(ga - a2) <= size and abs(gb - b2) <= size:
                        grp.append((a2, b2)); used[j] = True; changed = True
                        break
                if changed:
                    break
        amin = min(x[0] for x in grp); amax = max(x[0] for x in grp)
        bmin = min(x[1] for x in grp); bmax = max(x[1] for x in grp)
        regions.append((amin, amax + size, bmin, bmax + size))
    return regions


def find_exact_regions(files):
    """Return list of clusters; each cluster = list of (file, start, end)."""
    index = defaultdict(list)  # fp -> [(fname, start)]
    for fname, raw in files:
        nl = [norm_line(l) for l in raw]
        for i in range(len(nl) - WINDOW + 1):
            win = nl[i:i + WINDOW]
            if any(not w for w in win):
                continue
            index[md5('\n'.join(win))].append((fname, i + 1))

    bypair = defaultdict(list)
    for fp, hits in index.items():
        if len(hits) < 2:
            continue
        byfile = defaultdict(list)
        for f, s in hits:
            byfile[f].append(s)
        files_ = list(byfile)
        for x in range(len(files_)):
            for y in range(x, len(files_)):
                fa, fb = files_[x], files_[y]
                for sa in byfile[fa]:
                    for sb in byfile[fb]:
                        if fa == fb and sa >= sb:
                            continue
                        bypair[(fa, fb)].append((sa, sb))

    # region per pair, then cluster by shared content
    # a region = (fa, a1, a2, fb, b1, b2). Cluster by connected components
    # where two regions share a location and the content at that location
    # is the same (they do, since regions are exact matches).
    regions = []
    for (fa, fb), pairs in bypair.items():
        for (a1, a2, b1, b2) in merge_regions(pairs, WINDOW):
            if a2 - a1 >= EXACT_MIN:
                regions.append((fa, a1, a2 - 1, fb, b1, b2 - 1))

    # build cluster graph: node = (file, start, end); edge if same content region
    # each region links node A <-> node B
    parent = {}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[ry] = rx

    for (fa, a1, a2, fb, b1, b2) in regions:
        na, nb = (fa, a1, a2), (fb, b1, b2)
        if na not in parent:
            parent[na] = na
        if nb not in parent:
            parent[nb] = nb
        union(na, nb)

    clusters = defaultdict(list)
    for node in parent:
        clusters[find(node)].append(node)

    out = []
    for nodes in clusters.values():
        size = nodes[0][2] - nodes[0][1] + 1
        out.append(sorted(nodes, key=lambda n: (n[0], n[1])))
    out.sort(key=lambda c: -(c[0][2] - c[0][1] + 1))
    return out


def find_similar_clusters(files):
    docs = [(f, [norm_line(l) for l in raw]) for f, raw in files]
    shingles = defaultdict(list)
    for di, (fname, nl) in enumerate(docs):
        for i in range(len(nl) - WINDOW + 1):
            win = nl[i:i + WINDOW]
            if any(not w for w in win):
                continue
            toks = []
            for w in win:
                toks += tokenize(w) + ['|']
            if len(toks) < 8:
                continue
            shingles[md5(' '.join(toks))].append((di, i))

    cand = set()
    for fp, hits in shingles.items():
        if len(hits) < 2:
            continue
        for x in range(len(hits)):
            for y in range(x + 1, len(hits)):
                d1, i1 = hits[x]; d2, i2 = hits[y]
                if d1 == d2:
                    continue
                cand.add((min(d1, d2), max(d1, d2), i1 if d1 < d2 else i2, i2 if d1 < d2 else i1))

    kept = []
    for (d1, d2, i1, i2) in cand:
        a = docs[d1][1]; b = docs[d2][1]
        ratio = SequenceMatcher(None, a[i1:i1 + WINDOW], b[i2:i2 + WINDOW]).ratio()
        if ratio >= SIM_THRESHOLD:
            kept.append((d1, d2, i1, i2, ratio))

    bypair = defaultdict(list)
    for d1, d2, i1, i2, r in kept:
        bypair[(d1, d2)].append((i1, i2, r))

    regions = []
    for (d1, d2), pairs in bypair.items():
        for (a1, a2, b1, b2) in merge_regions([(a, b) for a, b, _ in pairs], WINDOW):
            if a2 - a1 >= SIM_MIN:
                rs = [r for (_, _, r) in pairs if a1 <= _ < a2]
                best = max(rs) if rs else SIM_THRESHOLD
                regions.append((docs[d1][0], a1, a2 - 1, docs[d2][0], b1, b2 - 1, best))

    # cluster via union-find like level1
    parent = {}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[ry] = rx

    for (fa, a1, a2, fb, b1, b2, r) in regions:
        na, nb = (fa, a1, a2), (fb, b1, b2)
        if na not in parent:
            parent[na] = na
        if nb not in parent:
            parent[nb] = nb
        union(na, nb)

    clusters = defaultdict(list)
    for node in parent:
        clusters[find(node)].append(node)
    out = []
    for nodes in clusters.values():
        out.append(sorted(nodes, key=lambda n: (n[0], n[1])))
    out.sort(key=lambda c: -(c[0][2] - c[0][1] + 1))
    return out


def main():
    files, errs = load_files()
    print(f"Scanned {len(files)} TS/JS files under {SRC}")
    if errs:
        for p, e in errs:
            print(f"  ! read error: {p}: {e}")

    print("\n" + "=" * 74)
    print("LEVEL 1  EXACT DUPLICATE CLUSTERS (normalized-line identical)")
    print("=" * 74)
    c1 = find_exact_regions(files)
    if not c1:
        print("  (none)")
    for i, nodes in enumerate(c1, 1):
        size = nodes[0][2] - nodes[0][1] + 1
        files_ = len(set(n[0] for n in nodes))
        loc = "same file" if files_ == 1 else "cross file"
        print(f"\n  [E{i:02d}] {size} lines x {len(nodes)} locations | {loc}")
        for f, a, b in nodes:
            print(f"        {f}:{a}-{b}")

    print("\n" + "=" * 74)
    print(f"LEVEL 2  NEAR-DUPLICATE CLUSTERS (syntax similarity >= {SIM_THRESHOLD})")
    print("=" * 74)
    c2 = find_similar_clusters(files)
    if not c2:
        print("  (none)")
    for i, nodes in enumerate(c2, 1):
        size = nodes[0][2] - nodes[0][1] + 1
        files_ = len(set(n[0] for n in nodes))
        loc = "same file" if files_ == 1 else "cross file"
        print(f"\n  [S{i:02d}] ~{size} lines x {len(nodes)} locations | {loc}")
        for f, a, b in nodes:
            print(f"        {f}:{a}-{b}")

    tot1 = sum(n[0][2] - n[0][1] + 1 for n in c1)
    tot2 = sum(n[0][2] - n[0][1] + 1 for n in c2)
    print("\n" + "=" * 74)
    print("SUMMARY")
    print("=" * 74)
    print(f"  exact-duplicate clusters : {len(c1)}  (unique block lines {tot1})")
    print(f"  near-duplicate clusters  : {len(c2)}  (unique block lines {tot2})")


if __name__ == "__main__":
    main()
