# kHYPE 입금·버퍼·Core 배분 구조

작성: 2026-10-12 KST. **아래 우선순위 배분은 kHYPE 컨트랙트에 구현되어 있다.** 검토한 explorer 검증 소스의 함수 동작을 설명하며, 우리 Vault에 같은 자동 배분 기능을 추가한 문서는 아니다.

## 1. 입금과 지분 발행

`StakingFacet.stake()` 또는 `stake(validator)` → `_stakeInternal` → `_distributeStake` 순서로 실행된다. pause·whitelist·최소/최대 입금·한도를 검사한 뒤 기존 Accountant 교환비율로 입금액 전체에 해당하는 kHYPE를 mint한다. 이어 자금을 배분하고 `stakingAccountant.recordStake`를 호출한다. 버퍼에 남긴 금액도 발행 근거에 포함된다. EVM 배분 호출이 실패하면 같은 거래의 mint도 롤백된다. 이후 Core 처리 결과가 앞선 EVM 거래를 소급 revert시키지는 않는다.

교환비율과 외부 보상 보고는 [오라클 문서](khype-oracle.ko.md)를 따른다.

## 2. 컨트랙트가 실행하는 배분

| 우선순위 | 함수에서 사용하는 값 | 동작 |
| --- | --- | --- |
| 1. 즉시 출금 풀 | `pool.getEffectiveBuffer()`, `pool.targetInstantUnstakeBuffer()` | 목표 부족분과 남은 입금액 중 작은 금액을 `depositToBuffer`로 전송 |
| 2. 내부 버퍼 | `hypeBuffer`, `targetBuffer` | 내부 목표 부족분과 남은 입금액 중 작은 금액만큼 내부 장부 증가 |
| 3. Core 배정 | 위 두 단계를 거친 잔액 | 전송 정밀도 잔량을 버퍼에 남기고 나머지를 Core로 전송 |

풀 주소가 설정되지 않았으면 1단계를 건너뛴다. 중간에 남은 금액이 0이면 종료한다. 두 목표는 HYPE 절대 수량이며 이 함수가 TVL의 고정 비율을 매번 계산하지는 않는다. 관리자 권한의 `setTargetBuffer`로 조정할 수 있다. 이 문서는 실제 목표 수량 또는 운영자의 목표 산정 정책을 실측했다고 주장하지 않는다.

### 설명용 예시

입금 100 HYPE, 즉시 출금 풀 목표 500·유효 버퍼 480, 내부 목표 100·현재 90을 가정한다.

| 배분 | HYPE |
| --- | ---: |
| 즉시 출금 풀 보충 | 20 |
| 내부 버퍼 보충 | 10 |
| Core 전송 대상 | 70 |
| 지분 발행 계산에 쓰는 전체 입금 | 100 |

버퍼 둘이 이미 목표 이상이면 전송 정밀도에 맞는 입금 전액이 Core로 간다. 입금액이 첫 번째 부족분보다 작으면 전액이 즉시 출금 풀에 들어간다. 이 숫자는 실제 설정값이 아니다.

## 3. 유효 버퍼와 지급 가능 현금

`InstantUnstakePool.getEffectiveBuffer()`는 다음 값을 반환한다.

```text
유효 버퍼 = max(0,
    instantUnstakeBuffer
    + 활성 리밸런싱 목록의 미완료 금액 합계
    - treasuryCredit)
```

미완료 리밸런싱은 만기 여부와 무관하게 집계한다. 이미 보충을 요청한 금액을 반영해 중복 보충을 줄인다. Treasury의 임시 지원금은 갚을 부채이므로 차감한다.

**유효 버퍼는 지금 지급할 수 있는 현금과 다르다.** 미완료 회수액을 즉시 지급 가능한 잔고로 취급하면 안 된다. `depositToBuffer`는 StakingManager만 호출할 수 있고 `msg.value == amount`를 검사한 뒤 실제 버퍼 장부를 늘린다.

별도 `getBufferRebalanceStatus()`는 유효 버퍼가 목표 대비 `lowWaterMark` 아래인지 판단하고, 해당 하한 수준까지 부족한 금액을 반환한다. 이 조회만으로 Core 회수가 실행되지는 않는다. 신규 입금의 목표까지 보충하는 로직과 별도 리밸런싱 필요량 계산을 구분한다.

## 4. 전송 정밀도와 비동기 경계

입금액은 먼저 `1e10 wei` 배수인지 검사한다(HYPE EVM 18자리 → Core 8자리). 버퍼 보충 후 남은 금액이 이 단위에 맞지 않으면 잔량을 즉시 출금 풀, 풀이 없으면 내부 버퍼에 둔다.

나머지는 **입금 거래 안에서** HYPE 시스템 주소로 전송하고 CoreWriter staking deposit 액션을 제출한다. validator 위임은 `_queueL1Operation(..., UserDeposit)`에 넣고 이후 운영자가 처리한다. 따라서 “전액 EVM에 두고 나중에 bridge한다”는 구조와 다르다. 지분 발행 시점, Core 전송 제출, staking deposit 처리, validator 위임 완료는 구별한다.

## 5. 우리 Vault와 비교

현행 [ManagedAssetVault](../src/ManagedAssetVault.sol)는 다음을 구현한다.

- 실제 EVM 입금 수령량에 기반한 지분 발행.
- owner의 `queueCoreAllocation(amount)`와 `executeCoreAllocation()`으로 배정 예약/실행.
- 확정 출금 준비금을 제외한 `availableCash` 한도 검사. 예약 후 준비금이 늘어나면 실행 시 다시 검사.
- 배정하지 않고 남긴 EVM 현금이 유동성 버퍼 역할을 함.

**kHYPE 방식의 목표 버퍼 부족분 자동 보충·즉시 출금 풀·유효 버퍼 집계는 현재 구현하지 않았다.** 이번 요청은 해당 구조 문서화이며 자동 배분 도입이나 버퍼 목표값을 확정한 것이 아니다. 기존 메인넷 검증 범위는 [STATUS](STATUS.ko.md)를 따른다.

추후 도입한다면 확정 claim 준비금, 아직 주주에게 속한 자유 현금, 도착하지 않은 회수 금액을 분리해야 한다. 회수 예정액을 보충 필요량에 반영하더라도 즉시 지급 가능액이나 미확정 전송 NAV에 중복 포함하지 않는 정책이 필요하다. 이 부분은 설계 검토 항목이다.

## 6. 근거와 검증 범위

- [StakingFacet 검증 코드](https://hyperevmscan.io/address/0x4F2A7FDAB14dF9800B2115ff702ecbB9D7E8097d#code): `_stakeInternal`, `_distributeStake`.
- [AdminFacet 검증 코드](https://hyperevmscan.io/address/0x19682c7700C6CB5020Ab044f81f56852aC821cE9#code): 내부 `setTargetBuffer`.
- [InstantUnstakePool 검증 코드](https://hyperevmscan.io/address/0x665b67793594fc5C251a3C95cbEb4B6245Cd2123#code): `depositToBuffer`, `getEffectiveBuffer`, `getBufferRebalanceStatus`, `setTargetBuffer`.
- [StakingManager proxy](https://hyperevmscan.io/address/0x393D0B87Ed38fc779FD9611144aE649BA6082109#code): 앞선 읽기 전용 조회에서 위 pool 주소를 반환했다.

검증 소스 열람과 읽기 전용 주소 조회가 근거다. kHYPE에 직접 입금해 세 갈래 실제 자금 이동을 재현하지 않았고, 현재 목표 버퍼 수량도 이 문서에서는 조회하지 않았다. 업그레이드 가능한 외부 계약이므로 후속 적용 시 활성 구현과 설정을 다시 확인한다. 외부 소스를 우리 MIT 코드에 복제하지 않았다.
