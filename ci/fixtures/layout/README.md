# Layout fixtures

`{Client,Server}-<commit>.inl` are trimmed copies of `Assertions.inl` from
[AlienXAXS/StarRupture-Game-SDK](https://github.com/AlienXAXS/StarRupture-Game-SDK)
at the four builds below. The full files are 30 MB each; these keep 23 classes
(about 118 KB each) so the unit tests run anywhere.

| Short sha | Build |
|---|---|
| `abd0ebd` | CL-125368 |
| `f3eb06b` | CL-125897 |
| `0b3c9e6` | CL-126119 |
| `659656c` | CL-127004 |

Transitions: `abd0ebd` to `f3eb06b` (content update), `f3eb06b` to `0b3c9e6`
(hotfix), `0b3c9e6` to `659656c` (content update).

The kept classes:

* every used class that changes layout in any transition, on either side,
* six small used classes that never change,
* three used classes where the client and server layouts differ,
* `UWBP_InventorySlot_C`.

Whole `static_assert` blocks are copied unchanged, so the trimmed files parse
exactly like the originals.

`used-all.txt` is the output of `used-classes.mjs` over the loader and plugin
sources (248 names, resolved against the real Client and Server layouts).
`used-qualified.txt` is the subset reached through an explicit `SDK::` prefix
(194 names), which is the set the design's "6 / 0 / 2 used classes changed"
figures were counted with. The full list also catches classes reached through
`using namespace SDK` and `namespace SDK { }` forward declarations, which is
why it reports 13 / 0 / 2.

## Full-size check

```
node ci/fetch-layout-fixtures.mjs                    # about 270 MB, sha256-checked
LAYOUT_FULL_DIR=out/layout-full node --test ci/layout-diff.test.mjs
```

This asserts the figures measured on the full data: layout-changed classes
628 / 0 / 300 (client) and 629 / 0 / 300 (server), used classes 6 / 0 / 2 and
13 / 0 / 2, and the synthesized client matching the real one on 184,789 and
183,914 shared rows with no wrong row.
