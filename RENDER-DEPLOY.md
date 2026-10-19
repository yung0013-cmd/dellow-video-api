# Render 배포

이 폴더의 파일을 GitHub 저장소 최상위에 업로드하세요. ZIP 자체나 node_modules, .env는 업로드하지 않습니다.

1. Render에 로그인하고 New → Blueprint에서 해당 저장소를 연결합니다.
2. render.yaml을 읽으면 Docker 웹 서비스, /health 검사와 무작위 API_TOKEN이 설정됩니다.
3. ALLOWED_ORIGINS에는 사용 중인 앱의 실제 주소(예: https://dellow-ai-studio.netlify.app)를 입력하세요. Netlify 관리자 주소는 안 됩니다. 주소 끝 /는 빼세요.
4. 이 설정은 무료 시험용입니다. 무료 인스턴스의 작은 메모리와 CPU로 큰 영상 변환이 실패하거나 느릴 수 있습니다. 본 사용에는 2GB 이상 리소스를 검토하고 비용 확인 후 직접 선택하세요.
5. 배포가 Live가 되면 발급된 https://...onrender.com 주소의 /health를 열어 ok:true를 확인합니다.
6. 앱의 영상 변환 서버 주소에 발급된 주소를 넣습니다. Render 서비스 Environment의 API_TOKEN 값을 앱의 접속 키에 넣고 연결 확인을 누릅니다. 접속 키를 채팅이나 GitHub에 올리지 마세요.
7. 짧은 MP4로 구간과 자막을 지정하여 저장하고 휴대폰에서 다운로드한 파일을 재생합니다. 로컬 테스트 성공은 배포 서버 테스트를 대체하지 않습니다.

공식 문서: https://render.com/docs/blueprint-spec · https://render.com/docs/docker · https://render.com/docs/free
