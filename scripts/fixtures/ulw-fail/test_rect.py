"""Task 2 of the ulw-fail fixture: an impossible assertion so the verify command fails on purpose."""


def test_rect_area():
    from rect import rect_area

    assert rect_area(2, 3) == 6


def test_impossible():
    # Independent of the code under test on purpose: the only way to "pass" is to edit this file, which the
    # framework forbids and reverts. (A code-dependent version was gamed by a call counter in rect_area.)
    assert 1 == 2, "intentionally impossible: exercises the failed-task path"
