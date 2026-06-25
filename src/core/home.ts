import * as os from 'os';

// os.homedir() 는 $HOME 환경변수를 읽는데, macOS 앱 샌드박스(App Store 빌드)는
// $HOME 을 컨테이너(~/Library/Containers/<id>/Data)로 바꿔치기한다. 그러면
// ~/.claude·~/.codex 가 컨테이너 안을 가리켜 사용 기록이 항상 비어 보인다.
// getpwuid 로 조회하는 os.userInfo().homedir 는 샌드박스에서도 진짜 홈(/Users/<me>)을
// 돌려주므로, 사용자 데이터 경로를 만들 때는 이걸 쓴다. 진짜 폴더 접근은 별도로
// security-scoped 북마크로 허용받는다(main.ts). 비-MAS 빌드에선 둘이 같은 값이라 차이가 없다.
export function realHome(): string {
  try {
    const h = os.userInfo().homedir;
    if (h) return h;
  } catch {
    // getpwuid 조회 실패 시 $HOME 폴백
  }
  return os.homedir();
}
