"""Step 1 of the plan3 fixture: stack.py must expose a Stack class (push/pop/peek/is_empty)."""


def test_push_and_pop():
    from stack import Stack

    s = Stack()
    s.push(1)
    s.push(2)
    assert s.pop() == 2
    assert s.pop() == 1


def test_peek_does_not_remove():
    from stack import Stack

    s = Stack()
    s.push("a")
    assert s.peek() == "a"
    assert s.pop() == "a"


def test_is_empty():
    from stack import Stack

    s = Stack()
    assert s.is_empty() is True
    s.push(1)
    assert s.is_empty() is False
