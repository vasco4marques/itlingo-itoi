ARG NODE_VERSION=18.20.0
FROM node:${NODE_VERSION}-alpine AS base 

RUN apk add --no-cache git openssh bash libsecret 
ENV HOME=/home/theia
WORKDIR /home/theia
# COPY --from=0 --chown=theia:theia /home/theia /home/theia

# RUN sudo apt-get install -y g++ gcc make python2.7 pkg-config libx11-dev libxkbfile-dev libsecret-1-dev
RUN apk add --no-cache make pkgconfig gcc g++ python3 libx11-dev libxkbfile-dev libsecret-dev nano
RUN apk add openjdk11-jre dos2unix


# ADD $version.package.json ./package.json
# ARG GITHUB_TOKEN
FROM base AS build-ide

ENV THEIA_WEBVIEW_EXTERNAL_ENDPOINT='{{hostname}}'
ENV NODE_OPTIONS="--max-old-space-size=4096"



COPY ide /home/theia/ide
WORKDIR /home/theia/ide


RUN dos2unix gitUtils/cloneScript.sh
RUN dos2unix gitUtils/gitPermissionsFix.sh
RUN chmod a+x gitUtils/cloneScript.sh
RUN chmod a+x gitUtils/gitPermissionsFix.sh
#COPY startup.sh .
#RUN chmod +x startup.sh

WORKDIR /home/theia/ide
RUN yarn --scripts-prepend-node-path --cache-folder ./ycache && rm -rf ./ycache
RUN find node_modules/@theia/cli/bin -type f -print0 | xargs -0 dos2unix
# RUN yarn theia build
WORKDIR /home/theia/ide/itlingo-itoi
RUN yarn
WORKDIR /home/theia/ide/browser-app
RUN yarn
WORKDIR /home/theia/ide/itlingo-itoi
RUN rm src/browser/*.ts src/browser/*.tsx src/common/*.ts src/node/*.ts
WORKDIR /home/theia/ide/browser-app

FROM node:20-alpine AS build-plugins
RUN apk add --no-cache git openssh bash libsecret
RUN apk add --no-cache make pkgconfig gcc g++ python3 libx11-dev libxkbfile-dev libsecret-dev
RUN apk add openjdk11-jre dos2unix
RUN npm install -g @vscode/vsce@2.15.0

#Compile ASL extension
WORKDIR /home/theia
COPY plugins/asl-langium /home/theia/asl-langium
RUN dos2unix /home/theia/asl-langium/server/asl/bin/generator.sh
RUN dos2unix /home/theia/asl-langium/server/asl/bin/importer.sh
RUN chmod +x /home/theia/asl-langium/server/asl/bin/generator.sh
RUN chmod +x /home/theia/asl-langium/server/asl/bin/importer.sh
WORKDIR /home/theia/asl-langium
RUN yarn
RUN vsce package
#RUN cp asl-langium-0.0.1.vsix /home/theia/ide/plugins
#RUN cd .. && rm -rf asl-langium

#Compile RSL extension
WORKDIR /home/theia
COPY plugins/rsl-vscode-extension /home/theia/rsl-vscode-extension
WORKDIR /home/theia/rsl-vscode-extension
RUN yarn
RUN vsce package
#RUN cp rsl-vscode-extension-0.0.1.vsix /home/theia/ide/plugins
#RUN cd .. && rm -rf rsl-vscode-extension

#Compile RSL extension
WORKDIR /home/theia
COPY plugins/vscode-code-annotation /home/theia/vscode-code-annotation
WORKDIR /home/theia/vscode-code-annotation
RUN npm install
RUN vsce package
#RUN cp code-annotation-0.0.2-dev.vsix /home/theia/ide/plugins
#RUN cd .. && rm -rf vscode-code-annotation


RUN mkdir -p /tmp/theia/workspaces/tmp


FROM build-ide AS setup-server
COPY --from=build-plugins /home/theia/vscode-code-annotation/code-annotation-0.0.2-dev.vsix /home/theia/ide/plugins
COPY --from=build-plugins /home/theia/rsl-vscode-extension/rsl-vscode-extension-0.0.1.vsix /home/theia/ide/plugins
COPY --from=build-plugins /home/theia/asl-langium/asl-langium-0.0.1.vsix /home/theia/ide/plugins

COPY pack /home/theia/pack
RUN chmod 777 -R /home/theia/pack

EXPOSE $PORT
#EXPOSE 3000

 RUN addgroup theia && \
   adduser -G theia -s /bin/sh -D theia;
RUN chmod g+rw /home && \
   chown -R theia:theia /home/theia && \
   chown -R theia:theia /tmp;

ENV SHELL=/bin/sh \
   THEIA_DEFAULT_PLUGINS=local-dir:/home/theia/ide/plugins

USER theia

WORKDIR /home/theia/ide/browser-app
CMD ["yarn", "start", "--hostname", "0.0.0.0", "--port", "3000"]

