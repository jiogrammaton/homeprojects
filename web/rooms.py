"""The Home map: floors and rooms.

The user draws the map in the Home page's map editor; it's saved in the settings blob under 'map':
    {'floors': [{'id', 'name'}, ...], 'ground': <floor id with the yard>,
     'rooms': [{'id', 'name', 'emoji', 'floor', 'x', 'y', 'w', 'h'}, ...]}     (x/y/w/h in an 800 x 540 plan)
Until then DEFAULT_MAP (the starter layout) is used. The page passes DEFAULT_MAP to app.js (json_script).
Stairs ({'kind': 'stairs', 'floor', 'to', ...}), blocked-off areas ({'kind': 'blocked', ...}) and trees
({'kind': 'tree'}) are stored alongside rooms; they're drawn on the map but aren't rooms. Structures
({'kind': 'structure'}, e.g. a shed) are rooms.

The floor with id 'outside' is the property around the house (yard areas, structures, trees). Its items use the same
plan units, on a bigger canvas centred on the house, so they may have negative coordinates.

'house' (Whole house) and 'yard' (Yard & exterior) are built in: they always exist and are never drawn as rooms.
The yard's name and icon can be changed in the map editor (map['yard'] = {'name', 'emoji'}).
"""

import json

BUILTIN_ROOMS = [('house', 'Whole house', '🏠'), ('yard', 'Yard & exterior', '🌳')]


def _room(rid, name, emoji, floor, x, y, w, h):
    return {'id': rid, 'name': name, 'emoji': emoji, 'floor': floor, 'x': x, 'y': y, 'w': w, 'h': h}


DEFAULT_MAP = {
    'floors': [
        {'id': 'basement', 'name': 'Basement'},
        {'id': 'main', 'name': 'Main floor'},
        {'id': 'upper', 'name': 'Upstairs'},
        {'id': 'outside', 'name': 'Outside'},
    ],
    'ground': 'main',
    'rooms': [
        _room('garage', 'Garage', '🚗', 'main', 90, 80, 150, 230),
        _room('kitchen', 'Kitchen', '🍳', 'main', 240, 80, 200, 170),
        _room('dining', 'Dining room', '🍽️', 'main', 440, 80, 140, 170),
        _room('office', 'Office', '💻', 'main', 580, 80, 130, 170),
        _room('living', 'Living room', '🛋️', 'main', 240, 290, 230, 170),
        _room('bath', 'Bathrooms', '🛁', 'main', 470, 290, 100, 170),
        _room('bedroom', 'Bedrooms', '🛏️', 'main', 570, 290, 140, 170),
        _room('basement', 'Basement', '🪜', 'basement', 90, 80, 620, 380),
        # Outside: a back and a front yard around the house (app.js withOutside() gives older maps the same)
        _room('backyard', 'Back yard', '🌻', 'outside', -110, -180, 1020, 240),
        _room('frontyard', 'Front yard', '🌱', 'outside', -110, 480, 1020, 240),
    ],
}

# Extra words accepted in a CSV "Room" column (matched without case or spaces). Used only when the
# room they point to still exists on the user's map.
ROOM_KINDS = ('room', 'structure')  # map items that are rooms (can hold tasks)

ALIASES = {
    'wholehouse': 'house',
    'home': 'house',
    'general': 'house',
    'house': 'house',
    'yard': 'yard',
    'exterior': 'yard',
    'outside': 'yard',
    'outdoor': 'yard',
    'outdoors': 'yard',
    'garden': 'yard',
    'yardexterior': 'yard',
    'yard&exterior': 'yard',
    'diningroom': 'dining',
    'livingroom': 'living',
    'familyroom': 'living',
    'den': 'living',
    'bedroom': 'bedroom',
    'bedrooms': 'bedroom',
    'bathroom': 'bath',
    'bathrooms': 'bath',
    'basement': 'basement',
    'cellar': 'basement',
    'crawlspace': 'basement',
    'laundry': 'basement',
    'laundryroom': 'basement',
    'study': 'office',
}


def _stored_settings():
    from .models import KeyValueStore  # imported here: models import nothing from this module

    kv = KeyValueStore.objects.filter(pk='settings').first()
    try:
        return json.loads(kv.v) if kv else {}
    except json.JSONDecodeError:
        return {}


def current_map(settings=None):
    """The user's map from settings (or the given settings dict), else the starter layout."""
    if settings is None:
        settings = _stored_settings()
    m = settings.get('map') if isinstance(settings, dict) else None
    if isinstance(m, dict) and isinstance(m.get('rooms'), list) and isinstance(m.get('floors'), list):
        return m
    return DEFAULT_MAP


def all_rooms(settings=None):
    """[(id, name, emoji)] for the built-ins plus every room and structure on the map
    (stairs, blocked-off areas and trees aren't rooms). The yard may have been renamed."""
    m = current_map(settings)
    rooms = [
        (str(r['id']), str(r.get('name') or ''), str(r.get('emoji') or ''))
        for r in m['rooms']
        if isinstance(r, dict) and r.get('id') and r.get('kind', 'room') in ROOM_KINDS
    ]
    builtins = list(BUILTIN_ROOMS)
    yard = m.get('yard') if isinstance(m.get('yard'), dict) else {}
    if str(yard.get('name') or '').strip():
        builtins[1] = ('yard', str(yard['name']).strip(), str(yard.get('emoji') or BUILTIN_ROOMS[1][2]))
    return builtins + rooms


def _key(text):
    return ''.join((text or '').lower().split())


def match_room(text, rooms=None):
    """Room id for free text (an id, a room name like 'Living room', or an alias like 'Laundry').
    '' if blank; None if it isn't a room on the current map. Pass `rooms` (from all_rooms) to avoid a lookup."""
    key = _key(text)
    if not key:
        return ''
    rooms = rooms if rooms is not None else all_rooms()
    for rid, name, _ in rooms:
        if key == _key(rid) or key == _key(name):
            return rid
    alias = ALIASES.get(key)
    return alias if alias and any(rid == alias for rid, _, _ in rooms) else None


# A project's room when none is stored: mirrors guessRoom()/ROOM_GUESS in app.js
LEGACY_ROOMS = {'laundry': 'basement'}
ROOM_GUESS = [
    ('kitchen', r'kitchen|pantry'),
    ('garage', r'garage|workshop'),
    ('basement', r'basement|cellar|crawl ?space|sump|laundry|washer|dryer'),
    ('bath', r'bath|shower|toilet'),
    ('bedroom', r'bed ?room|nursery|guest room'),
    ('dining', r'dining'),
    ('office', r'office|study'),
    ('living', r'living|family room|fireplace|\bden\b'),
    (
        'yard',
        r'exterior|outdoor|outside|yard|lawn|garden|landscap|roof|gutter|deck|patio|porch|fence|pool|siding|driveway',
    ),
]


def guess_room(project, settings=None, rooms=None):
    """A project named after a map room goes there ("Kitchen remodel" -> kitchen), else keyword hints, else 'house'."""
    import re

    m = current_map(settings)
    rooms = rooms if rooms is not None else all_rooms(settings)
    ids = {rid for rid, _, _ in rooms}
    name = (project or '').lower()
    for r in m['rooms']:
        if isinstance(r, dict) and r.get('kind', 'room') in ROOM_KINDS and r.get('name'):
            base = str(r['name']).lower()
            base = base[:-1] if base.endswith('s') else base
            if base and base in name:
                return str(r['id'])
    for rid, pattern in ROOM_GUESS:
        if re.search(pattern, project or '', re.I) and rid in ids:
            return rid
    return 'house'


def room_for_project(project, settings, rooms):
    """The room a project's tasks count toward: the stored one if it's on the map, else a guess (roomFor in app.js)."""
    ids = {rid for rid, _, _ in rooms}
    stored = (settings.get('rooms') or {}).get(project) if isinstance(settings.get('rooms'), dict) else None
    stored = LEGACY_ROOMS.get(stored, stored)
    return stored if stored in ids else guess_room(project, settings, rooms)
