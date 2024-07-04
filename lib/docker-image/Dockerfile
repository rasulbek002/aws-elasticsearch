FROM docker.elastic.co/elasticsearch/elasticsearch:8.14.0
ENV REGION us-east-2
USER root
USER elasticsearch
WORKDIR /usr/share/elasticsearch
RUN bin/elasticsearch-plugin install --batch discovery-ec2 && sed -e '/^-Xm/s/^/#/g' -i /usr/share/elasticsearch/config/jvm.options
