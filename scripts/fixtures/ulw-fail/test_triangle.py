"""Task 3 of the ulw3 fixture: triangle.py must expose triangle_area(a, b, c) (Heron) and is_right(a, b, c)."""
import math


def test_triangle_area_heron():
    from triangle import triangle_area

    assert triangle_area(3, 4, 5) == 6
    assert math.isclose(triangle_area(2, 2, 2), math.sqrt(3))


def test_is_right():
    from triangle import is_right

    assert is_right(3, 4, 5) is True
    assert is_right(5, 3, 4) is True  # any side order
    assert is_right(2, 2, 2) is False


def test_invalid_triangle_rejected():
    import pytest
    from triangle import triangle_area

    with pytest.raises(ValueError):
        triangle_area(1, 2, 10)
