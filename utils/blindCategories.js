/**
 * Blind Top 75 카테고리 매핑
 *
 * "문제 풀이 현황" 테이블에는 LeetCode 홈페이지 기준 20+개 카테고리 대신
 * Blind Top 75 큐레이션의 10개 카테고리만 노출한다.
 *
 * 출처: https://www.teamblind.com/post/new-year-gift-curated-list-of-top-75-leetcode-questions-to-save-your-time-oam1oreu
 * 관련 이슈: https://github.com/DaleStudy/github/issues/34
 */

export const BLIND_CATEGORY_ORDER = [
  "Array",
  "Binary",
  "Dynamic Programming",
  "Graph",
  "Interval",
  "Linked List",
  "Matrix",
  "String",
  "Tree",
  "Heap",
];

/**
 * 문제 슬러그 → Blind 카테고리 배열.
 *
 * 한 문제가 여러 Blind 카테고리에 속할 수 있다 (예: merge-k-sorted-lists → Linked List + Heap).
 * `problem-categories.json`에 있지만 이 맵에 없는 문제는 Blind 75 밖이므로 집계에서 제외된다.
 */
export const BLIND_PROBLEM_MAP = {
  // Array (10)
  "two-sum": ["Array"],
  "best-time-to-buy-and-sell-stock": ["Array"],
  "contains-duplicate": ["Array"],
  "product-of-array-except-self": ["Array"],
  "maximum-subarray": ["Array"],
  "maximum-product-subarray": ["Array"],
  "find-minimum-in-rotated-sorted-array": ["Array"],
  "search-in-rotated-sorted-array": ["Array"],
  "3sum": ["Array"],
  "container-with-most-water": ["Array"],

  // Binary (5)
  "sum-of-two-integers": ["Binary"],
  "number-of-1-bits": ["Binary"],
  "counting-bits": ["Binary"],
  "missing-number": ["Binary"],
  "reverse-bits": ["Binary"],

  // Dynamic Programming (11)
  "climbing-stairs": ["Dynamic Programming"],
  "coin-change": ["Dynamic Programming"],
  "longest-increasing-subsequence": ["Dynamic Programming"],
  "longest-common-subsequence": ["Dynamic Programming"],
  "word-break": ["Dynamic Programming"],
  "combination-sum": ["Dynamic Programming"],
  "house-robber": ["Dynamic Programming"],
  "house-robber-ii": ["Dynamic Programming"],
  "decode-ways": ["Dynamic Programming"],
  "unique-paths": ["Dynamic Programming"],
  "jump-game": ["Dynamic Programming"],

  // Graph (8)
  "clone-graph": ["Graph"],
  "course-schedule": ["Graph"],
  "pacific-atlantic-water-flow": ["Graph"],
  "number-of-islands": ["Graph"],
  "longest-consecutive-sequence": ["Graph"],
  "alien-dictionary": ["Graph"],
  "graph-valid-tree": ["Graph"],
  "number-of-connected-components-in-an-undirected-graph": ["Graph"],

  // Interval (5)
  "insert-interval": ["Interval"],
  "merge-intervals": ["Interval"],
  "non-overlapping-intervals": ["Interval"],
  "meeting-rooms": ["Interval"],
  "meeting-rooms-ii": ["Interval"],

  // Linked List (6; merge-k-sorted-lists 는 Heap 과 중복)
  "reverse-linked-list": ["Linked List"],
  "linked-list-cycle": ["Linked List"],
  "merge-two-sorted-lists": ["Linked List"],
  "merge-k-sorted-lists": ["Linked List", "Heap"],
  "remove-nth-node-from-end-of-list": ["Linked List"],
  "reorder-list": ["Linked List"],

  // Matrix (4)
  "set-matrix-zeroes": ["Matrix"],
  "spiral-matrix": ["Matrix"],
  "rotate-image": ["Matrix"],
  "word-search": ["Matrix"],

  // String (10)
  "longest-substring-without-repeating-characters": ["String"],
  "longest-repeating-character-replacement": ["String"],
  "minimum-window-substring": ["String"],
  "valid-anagram": ["String"],
  "group-anagrams": ["String"],
  "valid-parentheses": ["String"],
  "valid-palindrome": ["String"],
  "longest-palindromic-substring": ["String"],
  "palindromic-substrings": ["String"],
  "encode-and-decode-strings": ["String"],

  // Tree (14)
  "maximum-depth-of-binary-tree": ["Tree"],
  "same-tree": ["Tree"],
  "invert-binary-tree": ["Tree"],
  "binary-tree-maximum-path-sum": ["Tree"],
  "binary-tree-level-order-traversal": ["Tree"],
  "serialize-and-deserialize-binary-tree": ["Tree"],
  "subtree-of-another-tree": ["Tree"],
  "construct-binary-tree-from-preorder-and-inorder-traversal": ["Tree"],
  "validate-binary-search-tree": ["Tree"],
  "kth-smallest-element-in-a-bst": ["Tree"],
  "lowest-common-ancestor-of-a-binary-search-tree": ["Tree"],
  "implement-trie-prefix-tree": ["Tree"],
  "design-add-and-search-words-data-structure": ["Tree"],
  "word-search-ii": ["Tree"],

  // Heap (3; merge-k-sorted-lists 는 Linked List 와 중복)
  "top-k-frequent-elements": ["Heap"],
  "find-median-from-data-stream": ["Heap"],
};

/**
 * 문제 슬러그에 해당하는 Blind 카테고리 배열을 반환한다.
 * Blind 75 밖의 문제는 빈 배열을 반환한다.
 *
 * @param {string} problemName
 * @returns {string[]}
 */
export function getBlindCategories(problemName) {
  return BLIND_PROBLEM_MAP[problemName] ?? [];
}
