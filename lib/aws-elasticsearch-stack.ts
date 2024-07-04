import * as cdk from "aws-cdk-lib";
import { Repository } from "aws-cdk-lib/aws-ecr";
import { DockerImageAsset } from "aws-cdk-lib/aws-ecr-assets";
import { Construct } from "constructs";
import path = require("path");
import { ECSCluster } from "./ecs-cluster";
import { ContainerImage, LogDriver } from "aws-cdk-lib/aws-ecs";
import { Peer, Port, SecurityGroup, Vpc } from "aws-cdk-lib/aws-ec2";
import { Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";

export class AwsElasticsearchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const dockerImage = new DockerImageAsset(this, "MyDockerImage", {
      directory: path.join(__dirname, "docker-image"), // Path to your Dockerfile
    });

    new cdk.CfnOutput(this, "DockerImageUri", {
      value: dockerImage.imageUri,
    });

    const repo = Repository.fromRepositoryAttributes(this, "Logical", {
      repositoryName: dockerImage.repository.repositoryName,
      repositoryArn: dockerImage.repository.repositoryArn,
    });

    const vpc = Vpc.fromLookup(this, (id = "VPC"), { isDefault: true });

    const elasticsearchServiceAccessSecurityGroup = new SecurityGroup(
      this,
      "SecurityGroup",
      {
        vpc,
      }
    );

    new ECSCluster(this, "CONSTRACT", {
      clusterName: "Cluster",
      ec2Services: [
        {
          containers: [
            {
              containerName: "ElasticsearchContainer",
              image: ContainerImage.fromEcrRepository(
                repo,
                dockerImage.assetHash
              ),
              environment: {
                "cluster.name": "ElasticsearchCluster",
                "node.name": "master",
                "discovery.seed_providers": "ec2",
                "cluster.initial_master_nodes": "master",
                "discovery.ec2.endpoint": "ec2.us-west-2.amazonaws.com",
                "discovery.ec2.host_type": "private_ip",
                "xpack.security.enabled": "false",
                "discovery.ec2.tag.Elasticsearch": "true",
                "network.host": "_ec2:privateIpv4_",
                "transport.port": "9300",
                ES_JAVA_OPTS: "-Xms1g -Xmx1g",
              },
              portMappings: [
                {
                  containerPort: 9200,
                  hostPort: 9200,
                },
                {
                  containerPort: 9300,
                  hostPort: 9300,
                },
                {
                  containerPort: 80,
                  hostPort: 80,
                },
              ],
              logging: LogDriver.awsLogs({
                streamPrefix: "ElasticsearchContainer",
              }),
            },
          ],
          ec2Tags: [
            {
              key: "Elasticsearch",
              value: "true",
            },
          ],
          name: "Service",
          serviceAccessEntity: {
            peer: Peer.securityGroupId(
              elasticsearchServiceAccessSecurityGroup.securityGroupId
            ),
            port: Port.tcp(9200),
          },
          ec2InlinePolicies: [
            new Policy(this, "ec2InlinePolicies", {
              statements: [
                new PolicyStatement({
                  actions: ["ec2:DescribeInstances"],
                  resources: ["*"],
                }),
              ],
            }),
          ],
          taskDefinitionOptions: {
            cpu: "1024",
            memoryMiB: "3072",
          },
        },
      ],
    });
  }
}
