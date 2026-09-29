"""Task 2 of the ulw3 fixture: rect.py must expose rect_area(w, h), rect_perimeter(w, h) and is_square(w, h)."""


def test_rect_area():
    from rect import rect_area

    assert rect_area(2, 3) == 6
    assert rect_area(2.5, 4) == 10.0
    assert rect_area(0, 5) == 0


def test_rect_perimeter():
    from rect import rect_perimeter

    assert rect_perimeter(2, 3) == 10
    assert rect_perimeter(1, 1) == 4


def test_is_square():
    from rect import is_square

    assert is_square(3, 3) is True
    assert is_square(3, 4) is False


def test_negative_side_rejected():
    import pytest
    from rect import rect_area

    with pytest.raises(ValueError):
        rect_area(-1, 2)
