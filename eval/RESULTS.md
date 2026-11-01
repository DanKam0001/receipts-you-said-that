# Evaluation results

Run date: 2026-11-01T11:45:32.373Z

## Status: COMPLETE

Fresh held-out claims were written before this revised verifier was run. The prior held-out set has been seen and is reported only as a secondary historical set; thresholds are tuned only on the tune set.

- Replay mode: skipped; validated cached transcript reused.
- Transcript cache used: yes.
- ASR: cuda/float16; model small.en; transcript utterances 189; chunk RTF mean 0.203, p95 0.214, max 1.264 (below 1.0 keeps pace).
- Local verifier: Xenova/nli-deberta-v3-small, CPU; each query retrieved up to 8 hybrid-ranked transcript windows of 1-3 adjacent utterances, then verified premise/hypothesis pairs. Mean pair inference 16.27 ms (target smoke range 10-15 ms).
- Thresholds selected on tune only: entailment 0.55, contradiction 0.35; tune correct 11/15 with zero false RECEIPT FOUND. Tune-only thresholds were saved to ignored data/nli-thresholds.json for the server.

## Fresh held-out results (headline, n=20)

- Outcome counts: RECEIPT FOUND 5, NO MATCH 14, CAN'T TELL 1.
- Correct outcome: 15/20 (75.0%); wrong false RECEIPT FOUND: 0.
- WER: 11.53% (253 edits / 2195 reference words).
- Claim-to-decision latency: mean 213.3 ms; p95 267.3 ms.
- Target (zero wrong false FOUND and at least 14/20 correct): MET.

## Fresh held-out claims

| ID | Claim | Expected | Actual | Entailment score | Candidate |
|---|---|---|---|---:|---|
| fresh-01 | you said Alice noticed maps and pictures hanging on pegs along the sides as she fell | RECEIPT FOUND | NO MATCH | 0.0002 | u5-7 |
| fresh-02 | you said she imagined asking whether the country was New Zealand or Australia | RECEIPT FOUND | RECEIPT FOUND | 0.9883 | u58-60 |
| fresh-03 | you said Alice had shrunk to ten inches tall after tasting the drink | RECEIPT FOUND | NO MATCH | 0.0001 | u184-186 |
| fresh-04 | you said she got nervous she might shrink away completely like a blown out candle | RECEIPT FOUND | NO MATCH | 0.0036 | u150-152 |
| fresh-05 | you said she tried climbing a leg of the glass table but it was too slippery | RECEIPT FOUND | RECEIPT FOUND | 0.9939 | u161-162 |
| fresh-06 | you said she found a tiny currant cake inside a little glass box under the table | RECEIPT FOUND | RECEIPT FOUND | 0.9748 | u176-178 |
| fresh-07 | you said Alice ate the cake expecting it might change her size, but nothing happened | RECEIPT FOUND | NO MATCH | 0.0004 | u158-160 |
| fresh-08 | you said the drink tasted like a mix of cherry tart, custard, pineapple, turkey, toffee and toast | RECEIPT FOUND | RECEIPT FOUND | 0.9858 | u141-143 |
| fresh-09 | you said Alice once tried to box her own ears for cheating while playing croquet against herself | RECEIPT FOUND | RECEIPT FOUND | 0.8854 | u171-173 |
| fresh-10 | you said she usually gave herself good advice but hardly ever followed it | RECEIPT FOUND | CAN'T TELL | 0.9989 | u168-170 |
| fresh-11 | you said the maps and pictures were painted on the ceiling above Alice | NO MATCH | NO MATCH | 0.0001 | u5-7 |
| fresh-12 | you said she wondered if the country was France or Italy | NO MATCH | NO MATCH | 0.0004 | u58-60 |
| fresh-13 | you said drinking the bottle made Alice grow to twenty inches tall | NO MATCH | NO MATCH | 0.0004 | u129-131 |
| fresh-14 | you said Alice was eager to shrink until she disappeared like a candle | NO MATCH | NO MATCH | 0.0002 | u184-186 |
| fresh-15 | you said the table leg was rough and easy for Alice to climb | NO MATCH | NO MATCH | 0.0002 | u160-162 |
| fresh-16 | you said the glass box with the cake was sitting on top of the table | NO MATCH | NO MATCH | 0.0008 | u175-177 |
| fresh-17 | you said the cake was labelled DRINK ME and covered in raisins | NO MATCH | NO MATCH | 0.0023 | u177-177 |
| fresh-18 | you said the cake immediately made Alice grow much taller | NO MATCH | NO MATCH | 0.0001 | u179-179 |
| fresh-19 | you said Alice was playing croquet against her sister when she cheated | NO MATCH | NO MATCH | 0.0000 | u5-5 |
| fresh-20 | you said Alice always followed every piece of advice she gave herself | NO MATCH | NO MATCH | 0.0000 | u168-169 |

## Previously seen claims (secondary; not blind)

Outcome counts: RECEIPT FOUND 5, NO MATCH 9, CAN'T TELL 1.

| ID | Expected | Actual | Entailment score |
|---|---|---|---:|
| held-16 | RECEIPT FOUND | RECEIPT FOUND | 0.9698 |
| held-17 | RECEIPT FOUND | RECEIPT FOUND | 0.9977 |
| held-18 | RECEIPT FOUND | NO MATCH | 0.0054 |
| held-19 | RECEIPT FOUND | RECEIPT FOUND | 0.9979 |
| held-20 | RECEIPT FOUND | CAN'T TELL | 0.9058 |
| held-21 | RECEIPT FOUND | RECEIPT FOUND | 0.9955 |
| held-22 | RECEIPT FOUND | NO MATCH | 0.0001 |
| held-23 | RECEIPT FOUND | NO MATCH | 0.0001 |
| held-24 | RECEIPT FOUND | RECEIPT FOUND | 0.9802 |
| held-25 | RECEIPT FOUND | NO MATCH | 0.0056 |
| held-26 | NO MATCH | NO MATCH | 0.0001 |
| held-27 | NO MATCH | NO MATCH | 0.0008 |
| held-28 | NO MATCH | NO MATCH | 0.0001 |
| held-29 | NO MATCH | NO MATCH | 0.0001 |
| held-30 | NO MATCH | NO MATCH | 0.0015 |

## Decision and synthetic-fixture changes pending evaluation

The preceding fresh-set metrics are from before the revised high-entailment negation guard and on-topic NO MATCH policy. They do not measure those changes. This update did not run eval. The next run also adds a separate 40-line first-person synthetic text fixture; its claims are not used to tune thresholds. The runner will report the NO MATCH/CAN'T TELL tradeoff and the synthetic claim table separately.
