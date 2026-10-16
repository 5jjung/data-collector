# data-collector

무신사 데이터 수집 모음. 수집기마다 폴더와 워크플로를 분리해 관리합니다.

| 수집기 | 폴더 | 워크플로 | 주기 | 내용 |
|---|---|---|---|---|
| 랭킹 일일 리포트 | `rank-monitor/` | `rank-monitor-daily.yml` | 매일 18:00 KST | 랭킹 TOP500 브랜드 진입·무배당발 현황 → 슬랙 |
| 관심고객수 | `viewer-monitor/` | `viewer-monitor.yml` | 30분 | 코드그라피 상품 보는인원·좋아요 → 시트/슬랙 |
| 경량 아우터 | `light-outer-monitor/` | `light-outer-monitor.yml` | 30분 (정각/30분) | 랭킹 1~500위 중 "경량" 아우터 지표 누적 → 시트/CSV |

설정 방법은 각 폴더의 README 를 참고하세요.
