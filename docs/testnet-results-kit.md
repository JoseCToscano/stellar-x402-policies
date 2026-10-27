# Kit testnet run

Live run on 2026-10-27. Friendbot funded the owner, the agent, two merchants, and the facilitator. Seeds stayed in process memory.

| Role | Address |
| --- | --- |
| Smart account | `CDS2MQUJNFUEH52JKRA4KKFCR4GMXXTALKRIERUF5OCZM5J4PNZHP4PF` |
| Owner | `GBGJKOPHGQ2OX5VFKEPAPG3QBGYNT3UQ4OQV7QSYXMLDVYSL2V3R73XO` |
| Agent | `GBXGRRXU3OE54FMJEFTKCSH5FM4YPR27PEUB5CEZHAJACAAYTAHQCTOP` |
| Merchant A (allowlisted, 0.3 XLM/day, 0.15 XLM/tx) | `GCNJFDOF3HEITOANXMS63GGEVSRYTSNT6I6FUFDLFXMFERUDMCG7R5L5` |
| Merchant B (not listed) | `GDJQ4LXHHB3FYHMRVIRFBS4MSFUJSVH5SC2X7WLGFFAQ7EFBAPJ5WERJ` |
| Facilitator | `GBDG72FNS5UHZQWSRRCZ3PTX2H62LOZBLMUWW5VVVEDPI5GPP2G7BCG5` |

Account WASM `c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1`. Verifier `CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4`. `spending_limit` `CC3CEYQAP6NPNFIYSWL5MVZRCPJZGWX4XO7WDEJOUVGO2FZX5OONYPA5` (1 XLM/day). `merchant-allowlist` `CAP53MP7CWG3TTOQNMICVSNIBFMNEE7HYNOK4O2OP3FVBBB4YK6UAZP6`. `period-cap` `CB2VQO2NYP4DJBPNCZGRGEUKIUCK7BJW66OXEPDHV7RJT2ICW23X3EL5` is on the verifier allowlist and is not installed by this template.

## Setup

| Step | Fee charged | Transaction |
| --- | ---: | --- |
| Deploy account | 102692 | [d26d4c76f6f6b5311f9e9955ca478aad7ca4b64e2125dcd02cbae66c9cdf6d72](https://stellar.expert/explorer/testnet/tx/d26d4c76f6f6b5311f9e9955ca478aad7ca4b64e2125dcd02cbae66c9cdf6d72) |
| Fund 5 XLM | 100909 | [097c0997a681fe538657dd8bee2bc5efb06ea20cc49b8cbf553fa620cde0fe27](https://stellar.expert/explorer/testnet/tx/097c0997a681fe538657dd8bee2bc5efb06ea20cc49b8cbf553fa620cde0fe27) |
| Install rules | 653026 | [f6c56e10a227622daf73db82aec1c503dd5b555c6647fd818962e9ae36e27a0c](https://stellar.expert/explorer/testnet/tx/f6c56e10a227622daf73db82aec1c503dd5b555c6647fd818962e9ae36e27a0c) |

## Reference scheme

A signed 0.1 XLM payment to merchant A (simulated settlement fee 581130 stroops) was rejected by stock `ExactStellarScheme` before the MCP payments.

| Ceiling | Reason |
| --- | --- |
| Default | `invalid_exact_stellar_payload_fee_exceeds_maximum` |
| Raised above the simulated fee | `invalid_exact_stellar_payload_event_not_transfer` |

Default message: simulation-derived fee 581130 stroops exceeds ceiling 50000 stroops

## MCP payments

Pays went through the stdio MCP server. The fee bid is the facilitator envelope fee. The charged fee is what the network kept.

| Step | Result | Fee charged | Fee bid | Transaction |
| --- | --- | ---: | ---: | --- |
| A 0.1 XLM cold | settled | 503028 | 581130 | [510bcb56b4497e2a741de28fb569e6387a965230f002ccdab8e7d160398fa589](https://stellar.expert/explorer/testnet/tx/510bcb56b4497e2a741de28fb569e6387a965230f002ccdab8e7d160398fa589) |
| A 0.1 XLM warm | settled | 81462 | 96323 | [5f8fa55e4106f2283491484c63079d53b7ace8a532a003b93e5e5c17830e63f1](https://stellar.expert/explorer/testnet/tx/5f8fa55e4106f2283491484c63079d53b7ace8a532a003b93e5e5c17830e63f1) |
| A 0.15 XLM | `needs_owner_approval over_cap` | | | |
| B 0.1 XLM precheck | `needs_owner_approval merchant_not_allowed` | | | |
| B 0.1 XLM force-submit | FAILED `invokeHostFunctionTrapped` | 8643 | | [8a56629efe98a7daa61e28b1ec735b24e424e2a783ba8f1920fb64f5afa201f7](https://stellar.expert/explorer/testnet/tx/8a56629efe98a7daa61e28b1ec735b24e424e2a783ba8f1920fb64f5afa201f7) |

The MCP precheck refused merchant B before any facilitator call. The force-submit bypasses that precheck. The signed simulation failed in `merchant-allowlist` `enforce` with `Error(Contract, #3401)`. The host reported that as `Error(Auth, InvalidAction)` because `__check_auth` trapped. The submitted transaction failed on-chain with `invokeHostFunctionTrapped` and charged 8643 stroops.

## sxp inspect before

```json
{
  "address": "CDS2MQUJNFUEH52JKRA4KKFCR4GMXXTALKRIERUF5OCZM5J4PNZHP4PF",
  "ledger": 5408466,
  "warnings": [],
  "rules": [
    {
      "id": 0,
      "type": "Default",
      "name": "multisig",
      "signers": [
        {
          "kind": "external",
          "address": "",
          "verifier": "CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4"
        }
      ],
      "policies": []
    },
    {
      "id": 1,
      "type": "CallContract",
      "contract": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      "name": "xlm-merchants",
      "validUntil": 5608465,
      "signers": [
        {
          "kind": "external",
          "address": "",
          "verifier": "CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4"
        }
      ],
      "policies": [
        {
          "address": "CAP53MP7CWG3TTOQNMICVSNIBFMNEE7HYNOK4O2OP3FVBBB4YK6UAZP6",
          "name": "merchant-allowlist"
        },
        {
          "address": "CC3CEYQAP6NPNFIYSWL5MVZRCPJZGWX4XO7WDEJOUVGO2FZX5OONYPA5",
          "name": "spending_limit"
        }
      ]
    }
  ],
  "merchants": [
    {
      "merchant": "GCNJFDOF3HEITOANXMS63GGEVSRYTSNT6I6FUFDLFXMFERUDMCG7R5L5",
      "remaining": "3000000",
      "allowed": true
    }
  ]
}
```

## sxp inspect after

```json
{
  "address": "CDS2MQUJNFUEH52JKRA4KKFCR4GMXXTALKRIERUF5OCZM5J4PNZHP4PF",
  "ledger": 5408470,
  "warnings": [],
  "rules": [
    {
      "id": 0,
      "type": "Default",
      "name": "multisig",
      "signers": [
        {
          "kind": "external",
          "address": "",
          "verifier": "CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4"
        }
      ],
      "policies": []
    },
    {
      "id": 1,
      "type": "CallContract",
      "contract": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      "name": "xlm-merchants",
      "validUntil": 5608465,
      "signers": [
        {
          "kind": "external",
          "address": "",
          "verifier": "CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4"
        }
      ],
      "policies": [
        {
          "address": "CAP53MP7CWG3TTOQNMICVSNIBFMNEE7HYNOK4O2OP3FVBBB4YK6UAZP6",
          "name": "merchant-allowlist"
        },
        {
          "address": "CC3CEYQAP6NPNFIYSWL5MVZRCPJZGWX4XO7WDEJOUVGO2FZX5OONYPA5",
          "name": "spending_limit"
        }
      ]
    }
  ],
  "merchants": [
    {
      "merchant": "GCNJFDOF3HEITOANXMS63GGEVSRYTSNT6I6FUFDLFXMFERUDMCG7R5L5",
      "remaining": "1000000",
      "allowed": true
    }
  ]
}
```
