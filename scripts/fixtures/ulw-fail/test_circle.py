"""Task 1 of the ulw3 fixture: circle.py must expose circle_area(r) and circle_perimeter(r)."""
import math


def test_circle_area():
    from circle import circle_area

    assert math.isclose(circle_area(1), math.pi)
    assert math.isclose(circle_area(2.5), math.pi * 6.25)
    assert circle_area(0) == 0


def test_circle_perimeter():
    from circle import circle_perimeter

    assert math.isclose(circle_perimeter(1), 2 * math.pi)
    assert circle_perimeter(0) == 0


def test_negative_radius_rejected():
    import pytest
    from circle import circle_area

    with pytest.raises(ValueError):
        circle_area(-1)
