# Evaluation results

Run date: 2026-11-01T12:14:33.867Z

## Status: COMPLETE

Fresh held-out claims were written before this revised verifier was run. The prior held-out set has been seen and is reported only as a secondary historical set; thresholds are tuned only on the tune set.

- Replay mode: skipped; validated cached transcript reused.
- Transcript cache used: yes.
- ASR: cuda/float16; model small.en; transcript utterances 189; chunk RTF mean 0.203, p95 0.214, max 1.264 (below 1.0 keeps pace).
- Local verifier: Xenova/nli-deberta-v3-small, CPU; each query retrieved up to 8 hybrid-ranked transcript windows of 1-3 adjacent utterances, then verified premise/hypothesis pairs. Mean pair inference 15.37 ms (target smoke range 10-15 ms).
- Tune-only thresholds: entailment 0.55, contradiction 0.35, negation guard 0.800, on-topic retrieval 0.18; tune correct 14/15 with zero false RECEIPT FOUND. Tune-only thresholds were saved to ignored data/nli-thresholds.json for the server.
- NO MATCH policy: requires a retrieved on-topic contradiction or no retrieved candidate; neutral and weak off-topic windows return CAN'T TELL. This protects viewers from losing a life when transcript evidence is weak, at the cost of more uncertain outcomes.

## Fresh held-out results (headline, n=20)

- Outcome counts: RECEIPT FOUND 6, NO MATCH 12, CAN'T TELL 2.
- Correct outcome: 15/20 (75.0%); wrong false RECEIPT FOUND: 0.
- WER: 11.53% (253 edits / 2195 reference words).
- Claim-to-decision latency: mean 214.3 ms; p95 253.6 ms.
- Target (zero wrong false FOUND and at least 14/20 correct): MET.

## Fresh held-out claims

| ID | Claim | Expected | Actual | Entailment score | Candidate |
|---|---|---|---|---:|---|
| fresh-01 | you said Alice noticed maps and pictures hanging on pegs along the sides as she fell | RECEIPT FOUND | NO MATCH | 0.0002 | u5-7 |
| fresh-02 | you said she imagined asking whether the country was New Zealand or Australia | RECEIPT FOUND | RECEIPT FOUND | 0.9883 | u58-60 |
| fresh-03 | you said Alice had shrunk to ten inches tall after tasting the drink | RECEIPT FOUND | NO MATCH | 0.0001 | u184-186 |
| fresh-04 | you said she got nervous she might shrink away completely like a blown out candle | RECEIPT FOUND | CAN'T TELL | 0.0036 | u150-152 |
| fresh-05 | you said she tried climbing a leg of the glass table but it was too slippery | RECEIPT FOUND | RECEIPT FOUND | 0.9939 | u161-162 |
| fresh-06 | you said she found a tiny currant cake inside a little glass box under the table | RECEIPT FOUND | RECEIPT FOUND | 0.9748 | u176-178 |
| fresh-07 | you said Alice ate the cake expecting it might change her size, but nothing happened | RECEIPT FOUND | NO MATCH | 0.0004 | u158-160 |
| fresh-08 | you said the drink tasted like a mix of cherry tart, custard, pineapple, turkey, toffee and toast | RECEIPT FOUND | RECEIPT FOUND | 0.9858 | u141-143 |
| fresh-09 | you said Alice once tried to box her own ears for cheating while playing croquet against herself | RECEIPT FOUND | RECEIPT FOUND | 0.8854 | u171-173 |
| fresh-10 | you said she usually gave herself good advice but hardly ever followed it | RECEIPT FOUND | RECEIPT FOUND | 0.9989 | u168-170 |
| fresh-11 | you said the maps and pictures were painted on the ceiling above Alice | NO MATCH | NO MATCH | 0.0001 | u5-7 |
| fresh-12 | you said she wondered if the country was France or Italy | NO MATCH | NO MATCH | 0.0004 | u58-60 |
| fresh-13 | you said drinking the bottle made Alice grow to twenty inches tall | NO MATCH | NO MATCH | 0.0004 | u129-131 |
| fresh-14 | you said Alice was eager to shrink until she disappeared like a candle | NO MATCH | NO MATCH | 0.0002 | u184-186 |
| fresh-15 | you said the table leg was rough and easy for Alice to climb | NO MATCH | NO MATCH | 0.0002 | u160-162 |
| fresh-16 | you said the glass box with the cake was sitting on top of the table | NO MATCH | NO MATCH | 0.0008 | u175-177 |
| fresh-17 | you said the cake was labelled DRINK ME and covered in raisins | NO MATCH | CAN'T TELL | 0.0023 | u177-177 |
| fresh-18 | you said the cake immediately made Alice grow much taller | NO MATCH | NO MATCH | 0.0001 | u179-179 |
| fresh-19 | you said Alice was playing croquet against her sister when she cheated | NO MATCH | NO MATCH | 0.0000 | u5-5 |
| fresh-20 | you said Alice always followed every piece of advice she gave herself | NO MATCH | NO MATCH | 0.0000 | u168-169 |

## Synthetic text results (not speech; Whisper skipped)

This separate fixture uses the same hybrid retrieval, embeddings, NLI verifier, and chosen tune-only thresholds. No audio is present and Whisper transcription is skipped. Outcome counts: RECEIPT FOUND 9, NO MATCH 7, CAN'T TELL 0; correct 15/16.

| ID | Viewer wording | Expected | Actual | Entailment score | Candidate |
|---|---|---|---|---:|---|
| synthetic-01 | you said ranked was easy | RECEIPT FOUND | RECEIPT FOUND | 0.9094 | u35-35 |
| synthetic-02 | you said you don't solo queue in the middle of the night | RECEIPT FOUND | RECEIPT FOUND | 0.9851 | u6-7 |
| synthetic-03 | you said your aim is terrible before coffee | RECEIPT FOUND | RECEIPT FOUND | 0.9775 | u3-4 |
| synthetic-04 | you said the new map is better for sniping | RECEIPT FOUND | RECEIPT FOUND | 0.9899 | u7-8 |
| synthetic-05 | you said you saved your ultimate for the next fight | RECEIPT FOUND | RECEIPT FOUND | 0.9751 | u7-9 |
| synthetic-06 | you said the patch reduced your rifle's recoil | RECEIPT FOUND | RECEIPT FOUND | 0.9947 | u10-11 |
| synthetic-07 | you said the boss is easier if you're nearby | RECEIPT FOUND | RECEIPT FOUND | 0.9675 | u17-17 |
| synthetic-08 | you said you moved your sensitivity from four to five | RECEIPT FOUND | RECEIPT FOUND | 0.9741 | u23-25 |
| synthetic-09 | you said ranked lobbies are easy even when you're alone | NO MATCH | RECEIPT FOUND | 0.7950 | u34-36 |
| synthetic-10 | you said you always solo queue after midnight | NO MATCH | NO MATCH | 0.0003 | u6-7 |
| synthetic-11 | you said your aim is great before coffee | NO MATCH | NO MATCH | 0.0002 | u2-4 |
| synthetic-12 | you said turning motion blur on gives you smoother frames | NO MATCH | NO MATCH | 0.0004 | u16-16 |
| synthetic-13 | you said you like support when nobody watches flank | NO MATCH | NO MATCH | 0.0006 | u10-12 |
| synthetic-14 | you said you blamed the healer for losing that fight | NO MATCH | NO MATCH | 0.0015 | u13-15 |
| synthetic-15 | you said you use the right trigger to aim | NO MATCH | NO MATCH | 0.0005 | u22-24 |
| synthetic-16 | you said you already unlocked the gold camo | NO MATCH | NO MATCH | 0.0002 | u27-29 |

## Previously seen claims (secondary; not blind)

Outcome counts: RECEIPT FOUND 9, NO MATCH 6, CAN'T TELL 0.

| ID | Expected | Actual | Entailment score |
|---|---|---|---:|
| held-16 | RECEIPT FOUND | RECEIPT FOUND | 0.9698 |
| held-17 | RECEIPT FOUND | RECEIPT FOUND | 0.9977 |
| held-18 | RECEIPT FOUND | NO MATCH | 0.0054 |
| held-19 | RECEIPT FOUND | RECEIPT FOUND | 0.9979 |
| held-20 | RECEIPT FOUND | RECEIPT FOUND | 0.9058 |
| held-21 | RECEIPT FOUND | RECEIPT FOUND | 0.9955 |
| held-22 | RECEIPT FOUND | RECEIPT FOUND | 0.9968 |
| held-23 | RECEIPT FOUND | RECEIPT FOUND | 0.9946 |
| held-24 | RECEIPT FOUND | RECEIPT FOUND | 0.9802 |
| held-25 | RECEIPT FOUND | RECEIPT FOUND | 0.9378 |
| held-26 | NO MATCH | NO MATCH | 0.0001 |
| held-27 | NO MATCH | NO MATCH | 0.0008 |
| held-28 | NO MATCH | NO MATCH | 0.0001 |
| held-29 | NO MATCH | NO MATCH | 0.0001 |
| held-30 | NO MATCH | NO MATCH | 0.0015 |
