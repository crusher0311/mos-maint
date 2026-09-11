# Labor Rates access verification

## Evidence and limits

The reported “No accessible shop configured” response is from MOS's scoped
shop lookup, not Tekmetric's labor-rate API. Missing provider context alone is
not a proven explanation: the old broad lookup already searched Tekmetric fields.

Saved QA diagnostics show SMS shop 14245, an initial token failure, successful
reauthentication, and then scoped lookup failures for both Plan and Rates.
Older production captures successfully resolve SMS 14245 to MOS shop 63.
Saved Tekmetric HAR metadata contains successful labor-rate GETs. These historical
captures do not establish the current staff principal's membership or mapping.
No current production request/principal comparison was available; no production
membership, mapping, rule, or provider repair was performed.

Reproducible code defects were the preference for a global captured Tekmetric
shop over active context, omitted provider context, and asynchronous Rates state
that could survive context changes. Regression fixtures distinguish the external
SMS identity 14245 from internal MOS identity 63 and test access independently.

## Operator-only verification after release

1. On the intended Tekmetric location, observe (do not replay) Rates GET and a
   working Features/Plan GET in the same session. Compare provider, SMS shop ID,
   status, safe error code, and effective MOS shop scope. Never export tokens,
   authorization headers, customer details, or VINs.
2. Confirm Rates requests use `provider=tekmetric&smsShopId=14245`. If resolution
   still fails, inspect the stored provider mapping and current staff/principal
   membership using bounded read-only admin diagnostics. A 404 deliberately does
   not distinguish another shop's existence from absent configuration.
3. With operator approval, confirm configured groups load and a permitted save
   succeeds. Two editors saving the same revision must produce a conflict for
   the second save. Basic/read-only staff must remain unable to mutate.
4. On a designated test repair order, explicitly approve Apply Now and auto-apply
   verification. Confirm the intended RO changes once, and switching tabs/shops
   during reads does not carry rules or success notices into the new context.
   Do not automatically retry a failed or ambiguous provider write.
5. Any staff membership or provider mapping repair requires separate explicit
   operator approval. Do not reconnect Tekmetric based on the MOS lookup message.