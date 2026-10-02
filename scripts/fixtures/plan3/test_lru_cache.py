"""Step 3 of the plan3 fixture: lru_cache.py must expose an LRUCache(capacity) class (get/put, evicts least-recently-used)."""


def test_get_put_basic():
    from lru_cache import LRUCache

    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    assert c.get("a") == 1
    assert c.get("b") == 2


def test_missing_key_returns_none():
    from lru_cache import LRUCache

    c = LRUCache(2)
    assert c.get("missing") is None


def test_evicts_least_recently_used():
    from lru_cache import LRUCache

    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    c.get("a")  # touch a, so b becomes least-recently-used
    c.put("c", 3)  # evicts b
    assert c.get("b") is None
    assert c.get("a") == 1
    assert c.get("c") == 3
