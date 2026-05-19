FROM gradle:8.10.2-jdk21-alpine AS build
WORKDIR /workspace

COPY gradlew settings.gradle.kts build.gradle.kts gradle.properties ./
COPY gradle ./gradle
COPY src ./src

RUN ./gradlew bootJar --no-daemon \
    && JAR_PATH="$(find build/libs -name '*.jar' ! -name '*-plain.jar' | head -n 1)" \
    && cp "$JAR_PATH" /workspace/app.jar

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app

ENV SPRING_PROFILES_ACTIVE=production

COPY --from=build /workspace/app.jar /app/app.jar

EXPOSE 8080
LABEL org.mieweb.opensource-server.services.http.default-port=8080

ENTRYPOINT ["sh", "-c", "exec java ${JAVA_OPTS:-} -jar /app/app.jar"]
