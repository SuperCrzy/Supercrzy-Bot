"""流式数据处理测试模块：分块读取、行拆分、词频统计、滑动均值与管道组合。
每个函数独立可测，模块末尾提供命令行入口。
设计上全部采用惰性迭代，便于处理超大文件。
"""

import sys
import time
from collections import Counter, deque
from typing import Iterable, Iterator

CHUNK_SIZE = 4096
DEFAULT_LIMIT = 1000


def read_chunks(path: str, size: int = CHUNK_SIZE) -> Iterator[str]:
    """按指定大小分块读取文本文件，逐块产出内容。"""
    with open(path, "r", encoding="utf-8") as fh:
        while True:
            chunk = fh.read(size)
            if not chunk:
                break
            yield chunk


def split_lines(chunks: Iterable[str]) -> Iterator[str]:
    """将分块内容按行拆分，并处理跨块的行边界。"""
    buffer = ""
    for chunk in chunks:
        buffer += chunk
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            yield line
    if buffer:
        yield buffer


def count_words(lines: Iterable[str]) -> Counter:
    """统计所有行的单词出现次数，返回 Counter 对象。"""
    counter: Counter = Counter()
    for line in lines:
        counter.update(line.split())
    return counter


def moving_average(values: Iterable[float], window: int = 3) -> Iterator[float]:
    """对数值序列做滑动窗口平均，窗口未满时不产出。"""
    buf: deque = deque(maxlen=window)
    for value in values:
        buf.append(value)
        if len(buf) == window:
            yield sum(buf) / window


def pipeline(path: str, window: int = 3) -> dict:
    """组合读取→拆行→词频→滑动均值，返回统计摘要。"""
    chunks = read_chunks(path)
    lines = split_lines(chunks)
    freq = count_words(lines)
    nums = [float(w) for w in freq if w.isdigit()][:DEFAULT_LIMIT]
    avg = list(moving_average(nums, window))
    return {"word_count": sum(freq.values()), "top_words": freq.most_common(5),
            "digit_average": avg[-1] if avg else None}


def main(argv: list[str] | None = None) -> int:
    """命令行入口：对指定文件执行完整管道并打印摘要。"""
    argv = argv if argv is not None else sys.argv[1:]
    if not argv:
        print("用法: python test_stream_80.py <文件路径>")
        return 2
    t0 = time.perf_counter()
    result = pipeline(argv[0])
    print(f"单词总数: {result['word_count']}")
    print(f"高频词 TOP5: {result['top_words']}")
    print(f"耗时: {time.perf_counter() - t0:.3f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
