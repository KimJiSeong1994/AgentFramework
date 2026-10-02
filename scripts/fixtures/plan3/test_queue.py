"""Step 2 of the plan3 fixture: queue.py must expose a Queue class (enqueue/dequeue/is_empty), FIFO order."""


def test_enqueue_and_dequeue_fifo():
    from queue_ import Queue

    q = Queue()
    q.enqueue(1)
    q.enqueue(2)
    assert q.dequeue() == 1
    assert q.dequeue() == 2


def test_is_empty():
    from queue_ import Queue

    q = Queue()
    assert q.is_empty() is True
    q.enqueue("x")
    assert q.is_empty() is False


def test_dequeue_empty_raises():
    import pytest

    from queue_ import Queue

    q = Queue()
    with pytest.raises(IndexError):
        q.dequeue()
