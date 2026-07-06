# 기여 가이드 (CONTRIBUTING)

이 프로젝트에 기여해 주셔서 감사합니다. 아래는 협업을 매끄럽게 하기 위한 최소한의 규칙입니다.

## 작업 흐름

1. 이 저장소를 **포크**한다.
2. 포크에서 작업용 **브랜치**를 판다. (`feat/...`, `fix/...`, `docs/...`)
3. 변경 후 이 저장소의 `main` 으로 **Pull Request** 를 연다.
4. 오너 리뷰 후 병합된다.

커밋 메시지는 Conventional Commits(`type(scope): subject`, 명령형·소문자·마침표 없음)를 권장합니다.

## 오너 소유 파일 — PR에서 수정하지 말 것

아래 파일들은 **배포 신원·백엔드·서명 자산**이라, 외부 기여자 PR에서 바뀌면
오너의 릴리스나 신원에 직접 영향이 갑니다. 기능/버그 작업 중이라도 **건드리지 마세요.**
필요하다면 별도 이슈로 논의합니다.

| 경로 | 이유 |
| --- | --- |
| `src/core/remote.ts` | 오너의 Supabase 백엔드 연동 (URL/anon 키) |
| `.github/` | 릴리스·서명·공증 워크플로 (CI 시크릿 참조) |
| `build/` | 서명 엔타이틀먼트·아이콘 등 서명 자산 |
| `package.json` (`appId`·`author`·`notarize`) | 배포 메타데이터 |
| `app-store-listing.md` | App Store 리스팅(실명·저작권) |
| `docs/` | 개인정보 처리방침·연락 이메일 등 법적 신원 |

이 목록은 `.github/CODEOWNERS` 에도 반영되어 있어, 해당 경로가 담긴 PR은 오너에게 자동으로 리뷰가 요청됩니다.

## (선택) 오너를 위한 브랜치 보호 안내

기여자가 위 파일을 **실수로도 병합하지 못하게** 강제하려면, 오너가
`Settings → Rules → Rulesets` 에서 `main` 대상 룰셋을 만들고 다음을 켜면 됩니다.

- Require a pull request before merging
- Require review from **Code Owners**
- Block force pushes

> **1인 개발 편의:** 룰셋의 **Bypass list 에 오너 본인을 추가**하면,
> 규칙은 외부 기여자 PR에만 적용되고 오너는 평소처럼 `main` 에 직접 push 할 수 있습니다.
> (Bypass 없이 `enforce_admins` 를 켜면 자기 PR을 자기가 승인할 수 없어 스스로 잠기니 주의.)
>
> 참고로 외부 기여자는 write 권한이 없어 어차피 오너 승인 없이는 병합이 불가능하므로,
> 이 설정은 **협업자가 늘거나 실수 방지가 필요할 때** 켜면 충분합니다.
