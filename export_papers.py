# -*- coding: utf-8 -*-
"""Export Zotero library metadata from the sqlite snapshot to papers.json."""
import sqlite3, json, re, datetime

DB = 'zotero_snapshot.sqlite'
OUT = 'data/papers.json'

GITHUB_RE = re.compile(r'github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)', re.I)
GITHUB_EXCLUDE = {'issues', 'pull', 'blob', 'tree', 'raw', 'releases', 'archive',
                  'settings', 'actions', 'wiki', 'stargazers', 'forks', 'commits',
                  'tags', 'branches', 'packages', 'security', 'projects', 'topics',
                  'search', 'explore', 'login', 'signup', 'notifications', 'users',
                  'orgs', 'marketplace', 'pricing', 'sponsors', 'collections',
                  'trending', 'features', 'enterprise', 'team', 'customer-stories',
                  'readme', 'docs', 'apps', 'new', 'about', 'site'}

def extract_github(*texts):
    found = []
    for t in texts:
        if not t:
            continue
        for m in GITHUB_RE.finditer(t):
            owner, repo = m.group(1), m.group(2).rstrip('.,;)')
            if owner.lower() in GITHUB_EXCLUDE or repo.lower() in GITHUB_EXCLUDE:
                continue
            link = f'https://github.com/{owner}/{repo}'
            if link not in found:
                found.append(link)
    return found

def parse_year(date_str):
    if not date_str:
        return None
    m = re.search(r'(\d{4})', date_str)
    return int(m.group(1)) if m else None

con = sqlite3.connect(DB)
cur = con.cursor()

# field name -> value per item
cur.execute("""
SELECT id.itemID, f.fieldName, v.value
FROM itemData id
JOIN fields f ON id.fieldID = f.fieldID
JOIN itemDataValues v ON id.valueID = v.valueID
""")
item_fields = {}
for iid, fname, val in cur.fetchall():
    item_fields.setdefault(iid, {})[fname] = val

# creators
cur.execute("""
SELECT ic.itemID, c.firstName, c.lastName, ct.creatorType, ic.orderIndex
FROM itemCreators ic
JOIN creators c ON ic.creatorID = c.creatorID
JOIN creatorTypes ct ON ic.creatorTypeID = ct.creatorTypeID
ORDER BY ic.itemID, ic.orderIndex
""")
item_creators = {}
for iid, fn, ln, ctype, oi in cur.fetchall():
    item_creators.setdefault(iid, []).append(
        {'name': (' '.join(x for x in [fn, ln] if x)).strip(), 'type': ctype})

# tags
cur.execute("""
SELECT it.itemID, t.name FROM itemTags it JOIN tags t ON it.tagID = t.tagID
""")
item_tags = {}
for iid, tag in cur.fetchall():
    item_tags.setdefault(iid, []).append(tag)

# collections (with parent path)
cur.execute("SELECT collectionID, collectionName, parentCollectionID FROM collections")
coll_map = {cid: (name, pid) for cid, name, pid in cur.fetchall()}
def coll_path(cid):
    parts = []
    while cid and cid in coll_map:
        name, pid = coll_map[cid]
        parts.append(name)
        cid = pid
    return ' / '.join(reversed(parts))
cur.execute("SELECT collectionID, itemID FROM collectionItems")
item_colls = {}
for cid, iid in cur.fetchall():
    p = coll_path(cid)
    if p:
        item_colls.setdefault(iid, []).append(p)

# has local PDF attachment?
cur.execute("""
SELECT ia.parentItemID FROM itemAttachments ia
JOIN items i ON ia.itemID = i.itemID
JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
WHERE it.typeName = 'attachment' AND ia.contentType = 'application/pdf' AND ia.parentItemID IS NOT NULL
""")
has_pdf = set(r[0] for r in cur.fetchall())

# main items, excluding attachment/note
cur.execute("""
SELECT i.itemID, i.key, it.typeName, i.dateAdded
FROM items i JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
WHERE it.typeName NOT IN ('attachment', 'note')
ORDER BY i.itemID
""")

papers = []
for iid, key, typename, date_added in cur.fetchall():
    f = item_fields.get(iid, {})
    title = (f.get('title') or '').strip()
    if not title:
        continue
    creators = item_creators.get(iid, [])
    authors = [c['name'] for c in creators if c['type'] == 'author' and c['name']]
    editors = [c['name'] for c in creators if c['type'] == 'editor' and c['name']]
    all_names = [c['name'] for c in creators if c['name']]
    date_str = f.get('date', '')
    venue = (f.get('publicationTitle') or f.get('proceedingsTitle')
             or f.get('bookTitle') or f.get('conferenceName')
             or f.get('series') or f.get('university') or '')
    gh = extract_github(f.get('url'), f.get('extra'), f.get('abstractNote'))
    papers.append({
        'id': key,
        'title': title,
        'authors': authors,
        'editors': editors,
        'allAuthors': all_names,
        'firstAuthor': all_names[0] if all_names else '',
        'year': parse_year(date_str),
        'date': date_str,
        'type': typename,
        'venue': venue.strip(),
        'doi': (f.get('DOI') or '').strip(),
        'url': (f.get('url') or '').strip(),
        'extra': (f.get('extra') or '').strip(),
        'abstract': (f.get('abstractNote') or '').strip(),
        'tags': sorted(set(item_tags.get(iid, []))),
        'collections': sorted(set(item_colls.get(iid, []))),
        'hasPDF': iid in has_pdf,
        'github': gh,
        'dateAdded': date_added,
    })

con.close()

papers.sort(key=lambda p: (p['year'] or 0), reverse=True)
meta = {
    'generated': datetime.datetime.now().isoformat(timespec='seconds'),
    'count': len(papers),
    'withAbstract': sum(1 for p in papers if p['abstract']),
    'withDOI': sum(1 for p in papers if p['doi']),
    'withGithub': sum(1 for p in papers if p['github']),
    'withPDF': sum(1 for p in papers if p['hasPDF']),
}
import os
os.makedirs('data', exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as fp:
    json.dump({'meta': meta, 'papers': papers}, fp, ensure_ascii=False, separators=(',', ':'))

print(json.dumps(meta, indent=2))
print('json size MB:', round(os.path.getsize(OUT) / 1e6, 2))
types = {}
for p in papers:
    types[p['type']] = types.get(p['type'], 0) + 1
print('types:', sorted(types.items(), key=lambda x: -x[1]))
years = [p['year'] for p in papers if p['year']]
print('year range:', min(years), '-', max(years))
