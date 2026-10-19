# DELLOW Native FFmpeg Video API

Netlify 프런트엔드에서 원본 MP4와 자막 PNG, 시작/종료 시간을 받아 **네이티브 FFmpeg**로 변환합니다. WebM 녹화, 확장자 변경, 브라우저 인코딩을 사용하지 않습니다.

## 로컬 실행 (Node.js 22 이상)

```sh
npm install
npm start
```

pnpm 사용자: `pnpm install --frozen-lockfile`, `pnpm start`.
개발 의존성의 ffmpeg-static/ffprobe-static으로 Windows에서도 실행할 수 있습니다. 주소는 `http://127.0.0.1:8787`. PC에서 프런트엔드 `npm run dev`를 실행하면 이 주소를 기본으로 연결합니다. 휴대폰에서는 localhost가 아닌 배포된 HTTPS 서버가 필요합니다.

환경 파일은 자동으로 읽지 않습니다. `.env.example`을 `.env`로 복사한 경우 `node --env-file=.env server.mjs`로 시작하거나 호스팅 서비스의 환경 변수 설정을 이용하세요.

## 공개 서버 배포 (Docker)

Node.js/FFmpeg 프로세스를 실행하는 Docker 웹 서비스가 필요합니다. Netlify 정적 호스팅에 이 서버를 올리는 방식은 지원하지 않습니다.

1. 이 폴더의 소스를 Git 저장소에 올립니다. node_modules와 비밀 키는 포함하지 않습니다.
2. Render 등 Docker 지원 서비스에서 Web Service를 만들고 저장소를 연결합니다. 이 폴더가 저장소 루트가 아니라면 Root Directory를 지정합니다.
3. Dockerfile을 사용하고 다음 환경 변수를 설정합니다.

| 변수 | 값 |
| --- | --- |
| API_TOKEN | 본인만 아는 24자 이상의 무작위 값. 예: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`로 생성 |
| ALLOWED_ORIGINS | 실제 Netlify 사이트 주소. 예: `https://YOUR-SITE.netlify.app`. 관리자 주소 app.netlify.com을 넣지 않습니다. 여러 개는 쉼표로 구분 |
| HOST | `0.0.0.0` (Dockerfile 기본값) |
| PORT | 호스팅 플랫폼 제공 포트 또는 8787 |
| FFMPEG_PATH / FFPROBE_PATH | Dockerfile에 `/usr/bin/ffmpeg`, `/usr/bin/ffprobe` 설정됨 |

4. 상태 검사 경로를 `/health`로 설정합니다. 정상 응답은 `{"ok":true,"service":"dellow-native-ffmpeg","version":1}`입니다.
5. 플랫폼에서 발급한 HTTPS 주소를 프런트엔드 ‘영상 변환 서버 연결’에 입력하고 API_TOKEN을 ‘접속 키’에 넣습니다. 접속 키는 브라우저 메모리에만 보관하며 새로고침 시 다시 입력합니다.
6. 연결 확인 → 짧은 MP4 저장 → 완성된 MP4 다운로드 순서로 확인하세요.

서버는 단일 인스턴스/단일 변환 워커로 구성했습니다. 시작은 RAM 2GB 이상을 권장하며, 비용과 리소스는 선택한 플랫폼에서 확인하세요. 업로드 500MB, 출력 구간 최대 10분, 보관 중 작업 최대 4개입니다. 저장소는 임시 디스크이고 재시작/재배포하면 진행 작업 및 결과가 사라집니다. 여러 인스턴스로 늘리려면 별도 작업 큐·공유 저장소가 필요합니다.

Docker가 있는 환경의 직접 실행 예:

```sh
docker build -t dellow-video-api .
docker run --rm -p 8787:8787 --env-file .env dellow-video-api
```

Docker 이미지는 이 작업 환경에 Docker가 없어 직접 빌드하지 못했습니다. Windows에서 설치된 네이티브 FFmpeg를 사용하는 서버와 API는 실행·검증했습니다.

## 변환 및 검증

기본 명령의 핵심은 다음과 같습니다. 실제 실행에는 서버가 검증한 숫자·파일 경로만 전달하며 쉘 문자열로 합치지 않습니다.

```sh
ffmpeg -i input.mp4 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart -f mp4 output.mp4
```

실제 파이프라인은 먼저 구간을 선택하고 자막 PNG를 합성한 뒤 `libx264`로 최종 인코딩합니다. 출력: 최대 720p, 원본 비율 유지, Baseline Level 3.1, 30fps, yuv420p, AAC-LC 48kHz 스테레오. 오디오가 없으면 무음 AAC를 추가합니다. 원본은 덮어쓰지 않습니다.

완성 파일은 ffprobe 코덱·길이 검사 → MP4 ftyp/moov/mdat 및 faststart 순서 검사 → FFmpeg 전체 디코딩(`-xerror -f null`) → SHA-256 검사를 거쳐 공개됩니다. 입력/자막은 처리 후 삭제하고 결과는 작업 생성 후 약 1시간 이내(정리 간격 최대 1분 추가)에 삭제합니다. 다운로드 중인 파일의 만료 정리는 다운로드 종료 후 진행합니다.

다운로드는 서버의 **Content-Type: video/mp4**, **Content-Disposition: attachment**, **Content-Length**를 사용하는 HTTP 파일 응답입니다. Range 요청도 지원합니다. 서버가 발급한 무작위 다운로드 티켓은 결과가 삭제될 때까지 유효합니다. 브라우저가 출력 바이트를 Blob으로 다시 포장하지 않습니다.

## API

`/health` 외 요청은 공개 서버에서 `Authorization: Bearer API_TOKEN`이 필요합니다. 다운로드는 API_TOKEN 대신 작업별 티켓을 사용합니다.

- `GET /v1/connection`: 인증·연결 검사
- `POST /v1/jobs`: multipart `video`(MP4), `subtitle`(선택 PNG), `start`, `end` → 202 `{id}`
- `GET /v1/jobs/:id`: queued/processing/verifying/ready/failed, 진행률, 완료 시 downloadPath와 검증 보고서
- `GET /v1/jobs/:id/file?ticket=...`: 검증된 MP4 다운로드
- `DELETE /v1/jobs/:id`: 작업 취소·파일 삭제

## 테스트

```sh
npm test
```

네이티브 FFmpeg로 호환성이 낮은 H.264 4:4:4/ALAC 원본을 만들고 API를 통해 H.264 4:2:0/AAC로 변환합니다. 실제 다운로드 헤더·SHA256·전체 디코딩·구간 길이, 무음 오디오 처리, 잘못된 파일/구간, 인증 및 Origin 검사, 취소, Range 요청을 검증합니다.

실제 Android 기기 및 Instagram 업로드는 별도 실기기 확인이 필요합니다. 표준 형식만으로 모든 기기/계정/영상 길이·해상도 조건을 보증하지 않습니다.

공식 참고: https://ffmpeg.org/ffmpeg.html · https://render.com/docs/docker · https://render.com/docs/web-services
