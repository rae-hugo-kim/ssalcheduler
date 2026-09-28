# Examples

Real-world examples demonstrating the four core principles. Each example shows what LLMs commonly do wrong and how to fix it.

Inspired by [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.

---

## 1. Think Before Coding

> → Related rule: [`.omp/rules/harness-anti_hallucination.md`](.omp/rules/harness-anti_hallucination.md)

### Example: Hidden Assumptions

**User Request:** "Add a feature to export user data"

**Wrong — Silent Assumptions:**

```python
def export_users(format='json'):
    users = User.query.all()  # All users? Privacy?
    with open('users.json', 'w') as f:  # Where? What permissions?
        json.dump([u.to_dict() for u in users], f)  # Which fields?
```

Problems: Assumed ALL users, assumed file location, assumed fields to include, assumed output format.

**Right — Surface Assumptions:**

```
Before implementing, I need to clarify:

1. Scope: Export all users or filtered subset? (privacy implications)
2. Format: Download file? API endpoint? Background job?
3. Fields: Which user fields? Some may be sensitive.
4. Volume: How many users? (affects approach — pagination, streaming)

Simplest approach: API endpoint returning paginated JSON.
What's your preference?
```

---

## 2. Simplicity First

> → Related rule: [`.omp/rules/harness-change_control.md`](.omp/rules/harness-change_control.md)

### Example: Over-Abstraction

**User Request:** "Add a function to calculate discount"

**Wrong — Strategy Pattern for a Single Calculation:**

```python
from abc import ABC, abstractmethod

class DiscountStrategy(ABC):
    @abstractmethod
    def calculate(self, amount: float) -> float: ...

class PercentageDiscount(DiscountStrategy):
    def __init__(self, percentage: float):
        self.percentage = percentage
    def calculate(self, amount: float) -> float:
        return amount * (self.percentage / 100)

class FixedDiscount(DiscountStrategy):
    def __init__(self, fixed_amount: float):
        self.fixed_amount = fixed_amount
    def calculate(self, amount: float) -> float:
        return min(self.fixed_amount, amount)

# 40+ lines for something that should be 3
```

**Right — Just What Was Asked:**

```python
def calculate_discount(amount: float, percent: float) -> float:
    return amount * (percent / 100)
```

Self-check: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

Add complexity later when you actually need multiple discount types.

---

## 3. Surgical Changes

> → Related rule: [`.omp/rules/harness-change_control.md`](.omp/rules/harness-change_control.md)

### Example: Drive-by Refactoring

**User Request:** "Fix the bug where empty emails crash the validator"

**Wrong — Too Many Unrelated Changes:**

```diff
  def validate_user(user_data):
-     # Check email format
-     if not user_data.get('email'):
+     """Validate user data."""              # added docstring
+     email = user_data.get('email', '').strip()
+     if not email:
          raise ValueError("Email required")
-     if '@' not in user_data['email']:
+     if '@' not in email or '.' not in email.split('@')[1]:  # "improved" validation
          raise ValueError("Invalid email")
-     # Check username
-     if not user_data.get('username'):
+     username = user_data.get('username', '').strip()  # unrelated change
+     if not username:
          raise ValueError("Username required")
+     if len(username) < 3:                   # feature nobody asked for
+         raise ValueError("Username too short")
```

**Right — Only Fix the Bug:**

```diff
  def validate_user(user_data):
      # Check email format
-     if not user_data.get('email'):
+     email = user_data.get('email', '')
+     if not email or not email.strip():
          raise ValueError("Email required")
      # Basic email validation
-     if '@' not in user_data['email']:
+     if '@' not in email:
          raise ValueError("Invalid email")
```

The test: Every changed line should trace directly to the user's request.

---

## 4. Goal-Driven Execution

> → Related rules: [`.omp/rules/harness-verification_tests_and_evals.md`](.omp/rules/harness-verification_tests_and_evals.md), [`.omp/rules/harness-tdd_policy.md`](.omp/rules/harness-tdd_policy.md)

### Example: Vague vs. Verifiable

**User Request:** "Fix the authentication system"

**Wrong — Vague Approach:**

```
I'll fix the authentication system by:
1. Reviewing the code
2. Identifying issues
3. Making improvements
4. Testing the changes
```

**Right — Verifiable Goals:**

```
To fix authentication, I need specific success criteria.

If the issue is "users stay logged in after password change":

1. Write test: change password → old session still works
   → verify: test FAILS (reproduces bug)

2. Invalidate sessions on password change
   → verify: test PASSES

3. Add edge case tests: multiple sessions, concurrent changes
   → verify: all tests pass

4. Run full auth test suite
   → verify: no regressions
```

### Example: Test-First Bug Fix

**User Request:** "Sorting breaks with duplicate scores"

**Wrong — Fix Without Reproducing:**

```python
# Immediately changes sort logic without confirming the bug
def sort_scores(scores):
    return sorted(scores, key=lambda x: (-x['score'], x['name']))
```

**Right — Reproduce First:**

```python
# 1. Write test that reproduces the issue
def test_sort_with_duplicate_scores():
    scores = [
        {'name': 'Alice', 'score': 100},
        {'name': 'Bob', 'score': 100},
        {'name': 'Charlie', 'score': 90},
    ]
    result = sort_scores(scores)
    assert result[0]['name'] == 'Alice'  # deterministic order for ties
    assert result[1]['name'] == 'Bob'

# → verify: test FAILS (confirms bug)

# 2. Fix with stable sort
def sort_scores(scores):
    return sorted(scores, key=lambda x: (-x['score'], x['name']))

# → verify: test PASSES consistently
```

---

## Anti-Patterns Summary

| Principle | Anti-Pattern | Fix |
|-----------|-------------|-----|
| Think Before Coding | Silently assumes format, fields, scope | List assumptions explicitly, ask for clarification |
| Simplicity First | Strategy pattern for a single calculation | One function until complexity is actually needed |
| Surgical Changes | Reformats quotes, adds docstrings while fixing a bug | Only change lines that fix the reported issue |
| Goal-Driven | "I'll review and improve the code" | "Write test for bug X → make it pass → verify no regressions" |

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
