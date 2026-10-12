from pathlib import Path

root = Path("/home/celes/sources/omniroute-capacity-cascade-20261010T222530Z")
p = root / "tests/integration/chat-pipeline.test.ts"
s = p.read_text()
old = '    const json = (await response.json()) as any;\n\n    assert.equal(response.status, 200);\n    assert.equal(json.choices[0].message.content, "parent overflow succeeded");'
new = '    const json = (await response.json()) as {\n      choices: Array<{ message: { content: string } }>;\n    };\n\n    assert.equal(response.status, 200);\n    assert.equal(json.choices[0].message.content, "parent overflow succeeded");'
assert s.count(old) == 1
p.write_text(s.replace(old, new))

p = root / "tests/unit/chatcore-translation-paths.test.ts"
s = p.read_text()
old = '      connectionId,\n      userAgent: "unit-test",\n    } as any);\n\n    assert.equal(getAccountSemaphoreStats()[semaphoreKey]?.running, 1);'
new = '      connectionId,\n      userAgent: "unit-test",\n    });\n\n    assert.equal(getAccountSemaphoreStats()[semaphoreKey]?.running, 1);'
assert s.count(old) == 1
p.write_text(s.replace(old, new))
